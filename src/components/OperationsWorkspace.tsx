import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  CheckCircle2,
  Clock3,
  Cpu,
  Cloud,
  CloudOff,
  Download,
  FileCheck2,
  Gauge,
  GraduationCap,
  HardDrive,
  History,
  MapPin,
  PackagePlus,
  Power,
  Save,
  Settings2,
  Trash2,
  Trophy,
  Type,
  Upload,
  RotateCcw,
  Radio,
  MessageSquare,
  MousePointer2,
  Palette,
  Smartphone,
  ShieldCheck,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getPlanet } from "../game/content";
import { DIFFICULTY_DEFINITIONS } from "../game/difficulty";
import { ACHIEVEMENTS, getAchievementProgress } from "../game/progression";
import type { FactoryAlert } from "../game/alerts";
import type { SaveInspection, SaveIntegrityStatus, SaveSlotId, SaveSlotSummary, SaveSnapshotSummary } from "../game/storage";
import type { ModValidationResult } from "../game/mods";
import { getContentPackDependencyStatuses, getContentPackUsage, type ContentPackRegistry } from "../game/contentPacks";
import type { AutomaticPerformanceReport } from "../game/benchmark";
import type { DesktopReleaseInfo } from "../desktop";
import type { AutosaveIntervalSeconds, DifficultyMode, FontScale, GameSettings, GameState, SimulationSpeed } from "../game/types";
import { clearClientErrors, collectClientDiagnostics, downloadDiagnostics, getClientErrors } from "../game/diagnostics";
import { fetchCloudPublicStatus, resumeCloudSession, sendCloudFeedback, type CloudPublicStatus } from "../game/cloud";
import { resetOnboarding } from "../game/onboarding";
import { applyPwaUpdate, getPwaRuntimeState, requestPwaInstall, subscribePwaRuntime, type PwaRuntimeState } from "../pwa";
import { CURRENT_RELEASE_NOTES } from "./ReleaseNotesDialog";
import { SaveDeleteDialog, type SaveDeleteTarget } from "./SaveDeleteDialog";

export type OperationsTab = "alerts" | "achievements" | "settings" | "saves" | "packs" | "support";

interface OperationsWorkspaceProps {
  open: boolean;
  tab: OperationsTab;
  game: GameState;
  alerts: FactoryAlert[];
  slots: SaveSlotSummary[];
  snapshots: SaveSnapshotSummary[];
  importPreview: SaveInspection | null;
  modValidation: ModValidationResult | null;
  contentPackRegistry: ContentPackRegistry;
  performanceReport: AutomaticPerformanceReport | null;
  desktopRelease: DesktopReleaseInfo | null;
  onClose: () => void;
  onTabChange: (tab: OperationsTab) => void;
  onAlertSelect: (alert: FactoryAlert) => void;
  onSettingsChange: (settings: Partial<GameSettings>) => void;
  onManualSave: () => void;
  onExport: () => void;
  onImport: (raw: string) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onSaveSlot: (slotId: SaveSlotId) => void;
  onLoadSlot: (slotId: SaveSlotId) => void;
  onDeleteSlot: (slotId: SaveSlotId) => void;
  onCreateSnapshot: () => void;
  onLoadSnapshot: (snapshotId: string) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
  onRunBenchmark: () => void;
  onCheckDesktopUpdate: () => void;
  onInstallDesktopUpdate: () => void;
  onOpenReleaseNotes: () => void;
  onValidateMod: (raw: string) => void;
  onExportModTemplate: () => void;
  onRegisterContentPack: () => void;
  onSetContentPackEnabled: (packId: string, enabled: boolean) => void;
  onRemoveContentPack: (packId: string) => void;
}

const TABS: Array<{ id: OperationsTab; label: string; icon: typeof Bell }> = [
  { id: "alerts", label: "警报", icon: Bell },
  { id: "achievements", label: "成就", icon: Trophy },
  { id: "settings", label: "设置", icon: Settings2 },
  { id: "saves", label: "存档", icon: HardDrive },
  { id: "packs", label: "内容包", icon: PackagePlus },
  { id: "support", label: "诊断反馈", icon: MessageSquare },
];

function formatRuntime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function AlertsPanel({ alerts, onSelect }: { alerts: FactoryAlert[]; onSelect: (alert: FactoryAlert) => void }) {
  const criticalCount = alerts.filter((alert) => alert.severity === "critical").length;
  return (
    <div className="operations-panel operations-alerts">
      <header className="operations-section-header">
        <div><span>网络诊断</span><strong>运行警报</strong></div>
        <div className="operations-kpis">
          <span className="critical"><AlertTriangle size={13} />严重 <strong>{criticalCount}</strong></span>
          <span><Bell size={13} />全部 <strong>{alerts.length}</strong></span>
        </div>
      </header>
      {alerts.length === 0 ? (
        <div className="operations-empty">
          <CheckCircle2 size={28} />
          <strong>生产网络运行正常</strong>
          <span>当前没有需要处理的设备警报</span>
        </div>
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <button className={`alert-row alert-row--${alert.severity}`} type="button" key={alert.id} onClick={() => onSelect(alert)} title={`定位${alert.title}`}>
              <i>{alert.severity === "critical" ? <AlertTriangle size={17} /> : <Bell size={17} />}</i>
              <span><strong>{alert.title}</strong><small>{alert.reason}</small></span>
              <em><MapPin size={12} />{alert.location}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AchievementsPanel({ game }: { game: GameState }) {
  const unlocked = new Set(game.achievements.unlockedIds);
  return (
    <div className="operations-panel operations-achievements">
      <header className="operations-section-header">
        <div><span>工业里程碑</span><strong>成就记录</strong></div>
        <div className="achievement-total"><Trophy size={14} /><strong>{unlocked.size}</strong><span>/ {ACHIEVEMENTS.length}</span></div>
      </header>
      <div className="achievement-grid">
        {ACHIEVEMENTS.map((achievement, index) => {
          const complete = unlocked.has(achievement.id);
          const current = getAchievementProgress(game, achievement);
          const percent = Math.min(100, current / achievement.target * 100);
          return (
            <article className={`achievement-row${complete ? " achievement-row--complete" : ""}`} key={achievement.id}>
              <i>{complete ? <Trophy size={17} /> : String(index + 1).padStart(2, "0")}</i>
              <div><strong>{achievement.name}</strong><span>{achievement.description}</span></div>
              <em>{complete ? <CheckCircle2 size={14} /> : `${current}/${achievement.target}`}</em>
              <b><span style={{ width: `${percent}%` }} /></b>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ToggleSetting({ checked, label, value, icon, onChange }: {
  checked: boolean;
  label: string;
  value: string;
  icon: React.ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <i>{icon}</i>
      <span><strong>{label}</strong><small>{value}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <b aria-hidden="true"><i /></b>
    </label>
  );
}

function SettingsPanel({ game, report, desktopRelease, onChange, onRunBenchmark, onCheckDesktopUpdate, onInstallDesktopUpdate, onOpenReleaseNotes }: { game: GameState; report: AutomaticPerformanceReport | null; desktopRelease: DesktopReleaseInfo | null; onChange: (settings: Partial<GameSettings>) => void; onRunBenchmark: () => void; onCheckDesktopUpdate: () => void; onInstallDesktopUpdate: () => void; onOpenReleaseNotes: () => void }) {
  const { settings } = game;
  return (
    <div className="operations-panel operations-settings">
      <header className="operations-section-header">
        <div><span>模拟参数</span><strong>运行设置</strong></div>
        <span className="settings-state"><Gauge size={14} />{settings.simulationSpeed}× 模拟</span>
      </header>
      <section className="settings-group">
        <header><Zap size={14} /><span>模拟速度</span></header>
        <div className="settings-segmented" aria-label="模拟速度">
          {([1, 2, 4] as SimulationSpeed[]).map((speed) => (
            <button className={settings.simulationSpeed === speed ? "active" : ""} type="button" key={speed} onClick={() => onChange({ simulationSpeed: speed })}>{speed}×</button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><Type size={14} /><span>字体大小</span><small>{Math.round(settings.fontScale * 100)}%</small></header>
        <div className="settings-segmented" aria-label="字体大小">
          {([0.8, 1, 1.25, 1.5, 2] as FontScale[]).map((scale) => (
            <button className={settings.fontScale === scale ? "active" : ""} type="button" key={scale} aria-pressed={settings.fontScale === scale} onClick={() => onChange({ fontScale: scale })}>{Math.round(scale * 100)}%</button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><Palette size={14} /><span>界面主题</span><small>{{ dark: "深色", light: "亮色", system: "跟随系统" }[settings.theme]}</small></header>
        <div className="settings-segmented" aria-label="界面主题">
          {(["dark", "light", "system"] as const).map((theme) => <button className={settings.theme === theme ? "active" : ""} type="button" key={theme} onClick={() => onChange({ theme })}>{{ dark: "深色", light: "亮色", system: "跟随系统" }[theme]}</button>)}
        </div>
      </section>
      <section className="settings-group">
        <header><Settings2 size={14} /><span>科技树布局</span><small>{settings.technologyLayout === "compact" ? "精简" : "标准"}</small></header>
        <div className="settings-segmented" aria-label="科技树布局">
          <button className={settings.technologyLayout === "standard" ? "active" : ""} type="button" onClick={() => onChange({ technologyLayout: "standard" })}>标准模式</button>
          <button className={settings.technologyLayout === "compact" ? "active" : ""} type="button" onClick={() => onChange({ technologyLayout: "compact" })}>精简模式</button>
        </div>
      </section>
      <section className="settings-group settings-toggle-list">
        <ToggleSetting checked={settings.performanceMode} label="性能模式" value={settings.performanceMode ? "低频渲染" : "完整渲染"} icon={<Cpu size={16} />} onChange={(performanceMode) => onChange({ performanceMode })} />
        <ToggleSetting checked={settings.reducedMotion} label="减少动态效果" value={settings.reducedMotion ? "动态效果关闭" : "动态效果开启"} icon={<Gauge size={16} />} onChange={(reducedMotion) => onChange({ reducedMotion })} />
        <ToggleSetting checked={settings.soundEnabled} label="操作音效" value={settings.soundEnabled ? "声音开启" : "声音关闭"} icon={settings.soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />} onChange={(soundEnabled) => onChange({ soundEnabled })} />
        <ToggleSetting checked={settings.allowDoubleClickZoom} label="允许双击缩放" value={settings.allowDoubleClickZoom ? "双击聚焦画布" : "连续点击不缩放"} icon={<MousePointer2 size={16} />} onChange={(allowDoubleClickZoom) => onChange({ allowDoubleClickZoom })} />
      </section>
      <section className="settings-group">
        <header><Clock3 size={14} /><span>自动保存间隔</span></header>
        <div className="settings-segmented" aria-label="自动保存间隔">
          {([30, 60, 120] as AutosaveIntervalSeconds[]).map((seconds) => (
            <button className={settings.autosaveIntervalSeconds === seconds ? "active" : ""} type="button" key={seconds} onClick={() => onChange({ autosaveIntervalSeconds: seconds })}>{seconds} 秒</button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><MapPin size={14} /><span>星区与资源</span><small>种子 #{game.galaxy.seed}</small></header>
        <div className="settings-segmented" aria-label="资源模式">
          <button className={settings.resourceMode === "finite" ? "active" : ""} type="button" onClick={() => onChange({ resourceMode: "finite" })}>有限矿脉</button>
          <button className={settings.resourceMode === "infinite" ? "active" : ""} type="button" onClick={() => onChange({ resourceMode: "infinite" })}>无限矿脉</button>
        </div>
      </section>
      <section className="settings-group settings-difficulty-group">
        <header><Gauge size={14} /><span>工业难度</span><small>{DIFFICULTY_DEFINITIONS.find((definition) => definition.id === settings.difficulty)?.name ?? "标准"}</small></header>
        <div className="settings-segmented settings-difficulty-options" aria-label="工业难度">
          {DIFFICULTY_DEFINITIONS.map((definition) => (
            <button className={settings.difficulty === definition.id ? "active" : ""} type="button" key={definition.id} aria-pressed={settings.difficulty === definition.id} onClick={() => onChange({ difficulty: definition.id as DifficultyMode })} title={definition.summary}>
              {definition.name}
            </button>
          ))}
        </div>
        <p className="settings-help">{DIFFICULTY_DEFINITIONS.find((definition) => definition.id === settings.difficulty)?.summary ?? "按当前原型的默认节奏运行。"}</p>
      </section>
      <section className="settings-group settings-diagnostics">
        <header><ShieldCheck size={14} /><span>模拟诊断</span><small>确定性、2/8/24/72 小时挂机与数值平衡</small></header>
        <button type="button" onClick={onRunBenchmark} title="同时执行 2/8/24/72 小时挂机检查"><Gauge size={14} />运行 60 秒基准</button>
        {report ? <div className={`automatic-performance-report${report.benchmark.deterministic && report.idleStress.completed && report.idleStress.integrityPassed ? " automatic-performance-report--passed" : " automatic-performance-report--warning"}`}>
          <header><span>自动性能报告</span><small>{new Date(report.generatedAt).toLocaleTimeString("zh-CN")}</small></header>
          <div className="automatic-performance-metrics"><span>确定性 <strong>{report.benchmark.deterministic ? "通过" : "失败"}</strong></span><span>60 秒 <strong>{report.benchmark.durationMs} ms</strong></span><span>压力 <strong>{report.idleStress.simulatedHours} h / {report.idleStress.durationMs} ms</strong></span><span>整数校验 <strong>{report.idleStress.integrityPassed ? "通过" : "异常"}</strong></span></div>
          <div className="automatic-balance-metrics"><span>设备 {Math.round(report.balance.machineEfficiency * 100)}%</span><span>物流 {Math.round(report.balance.logisticsEfficiency * 100)}%</span><span>供电 {Math.round(report.balance.powerEfficiency * 100)}%</span><span>电力余量 {report.balance.powerMarginKw.toFixed(0)} kW</span></div>
          <div className="automatic-idle-checkpoints">{report.idleSuite.checkpoints.map((checkpoint) => <span className={checkpoint.integrityPassed ? "ready" : "warning"} key={checkpoint.hours}><small>{checkpoint.hours}h</small><strong>{checkpoint.integrityPassed ? "通过" : "异常"}</strong><em>{Math.round(checkpoint.producedPerHour).toLocaleString("zh-CN")}/h</em></span>)}</div>
          <div className="automatic-progression-audit">
            <header><span>新档至白糖</span><strong>{report.progression.observedWhiteMatrixHours != null ? `${report.progression.observedWhiteMatrixHours.toFixed(1)}h 实测` : `${report.progression.estimatedWhiteMatrixHours.toFixed(1)}h 预计`}</strong></header>
            <div>{report.progression.milestones.map((milestone) => <span className={milestone.complete ? "ready" : milestone === report.progression.nextMilestone ? "active" : ""} key={milestone.itemId}><small>{milestone.label.slice(0, 2)}</small><strong>{milestone.complete ? "完成" : `${Math.round(milestone.estimatedFromFreshMinutes / 60 * 10) / 10}h`}</strong></span>)}</div>
            {report.progression.nextMilestone ? <p>当前卡点：{report.progression.nextMilestone.blockers.join(" · ") || report.progression.nextMilestone.criticalPath.join(" → ")}</p> : <p>{report.progression.summary}</p>}
          </div>
          <p className={report.idleSuite.tuning.plateauDetected ? "automatic-idle-tuning warning" : "automatic-idle-tuning ready"}>{report.idleSuite.tuning.summary}</p>
          <ul>{report.balance.recommendations.slice(0, 3).map((recommendation) => <li key={recommendation}>{recommendation}</li>)}{report.idleStress.issues.slice(0, 2).map((issue) => <li className="warning" key={issue}>{issue}</li>)}</ul>
          {report.recommendedPerformanceMode ? <small className="automatic-performance-recommendation"><Cpu size={12} />当前工厂规模建议开启性能模式。</small> : null}
        </div> : null}
      </section>
      <section className="settings-group desktop-release-status">
        <header><Download size={14} /><span>桌面发布渠道</span><small>{desktopRelease ? `${desktopRelease.channelLabel} · v${desktopRelease.version}` : "Web / PWA"}</small></header>
        {desktopRelease ? <><div className={`desktop-update-state desktop-update-state--${desktopRelease.update.state}`}><span>{desktopRelease.update.message}</span>{desktopRelease.update.progress != null ? <strong>{desktopRelease.update.progress}%</strong> : null}</div><div className="desktop-update-actions"><button type="button" onClick={onCheckDesktopUpdate}><RotateCcw size={13} />检查更新</button>{desktopRelease.update.state === "downloaded" ? <button className="primary" type="button" onClick={onInstallDesktopUpdate}><Download size={13} />重启安装</button> : null}</div></> : <p className="settings-help">当前使用网页版本。桌面包支持稳定版、Beta 和 Nightly 渠道，以及应用内更新检查。</p>}
      </section>
      <section className="settings-group settings-release-notes">
        <header><History size={14} /><span>版本更新记录</span><small>{CURRENT_RELEASE_NOTES.date}</small></header>
        <button type="button" onClick={onOpenReleaseNotes} aria-label="查看版本更新记录"><History size={15} /><span><strong>{CURRENT_RELEASE_NOTES.title}</strong><small>{CURRENT_RELEASE_NOTES.items.length} 项体验更新</small></span></button>
      </section>
      <section className="settings-group settings-community">
        <header><MessageSquare size={14} /><span>QQ 交流群</span><small>意见、建议与问题反馈</small></header>
        <div><span>群号</span><strong>1076757280</strong></div>
      </section>
    </div>
  );
}

function integrityLabel(status: SaveIntegrityStatus): string {
  if (status === "valid") return "校验通过";
  if (status === "legacy") return "旧格式"
  if (status === "repaired") return "可修复"
  return "损坏"
}

function SavesPanel({
  game,
  slots,
  snapshots,
  importPreview,
  modValidation,
  onManualSave,
  onExport,
  onImport,
  onConfirmImport,
  onCancelImport,
  onSaveSlot,
  onLoadSlot,
  onDeleteSlot,
  onCreateSnapshot,
  onLoadSnapshot,
  onDeleteSnapshot,
  onValidateMod,
  onExportModTemplate,
}: Pick<OperationsWorkspaceProps,
  "game" | "slots" | "snapshots" | "importPreview" | "modValidation" | "onManualSave" | "onExport" | "onImport" | "onConfirmImport" | "onCancelImport" | "onSaveSlot" | "onLoadSlot" | "onDeleteSlot" | "onCreateSnapshot" | "onLoadSnapshot" | "onDeleteSnapshot" | "onValidateMod" | "onExportModTemplate">) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modInputRef = useRef<HTMLInputElement>(null);
  const [deleteRequest, setDeleteRequest] = useState<(SaveDeleteTarget & ({ kind: "slot"; slotId: SaveSlotId } | { kind: "snapshot"; snapshotId: string })) | null>(null);
  const summaryBySlot = new Map(slots.map((slot) => [slot.slotId, slot]));
  const automaticSnapshotCount = snapshots.filter((snapshot) => snapshot.reason === "自动快照").length;
  const manualSnapshotCount = snapshots.length - automaticSnapshotCount;
  return (
    <div className="operations-panel operations-saves">
      <header className="operations-section-header">
        <div><span>本地数据</span><strong>存档管理</strong></div>
        <span className="save-runtime"><Clock3 size={13} />运行 {formatRuntime(game.elapsedSeconds)}</span>
      </header>
      <section className="save-primary-actions">
        <button type="button" onClick={onManualSave}><Save size={15} /><span>立即保存</span></button>
        <button type="button" onClick={onCreateSnapshot}><History size={15} /><span>创建快照</span></button>
        <button type="button" onClick={onExport}><Download size={15} /><span>导出 JSON</span></button>
        <button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={15} /><span>导入 JSON</span></button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          aria-label="选择要导入的存档文件"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) onImport(await file.text());
            event.target.value = "";
          }}
        />
      </section>
      {importPreview ? <section className="save-import-preview" aria-label="存档导入预览">
        <header><div><FileCheck2 size={15} /><strong>导入预览</strong></div><span className={`save-integrity save-integrity--${importPreview.integrity}`}>{integrityLabel(importPreview.integrity)}</span></header>
        <div className="save-preview-metrics">
          <span><small>状态版本</small><strong>v{importPreview.stateVersion ?? "?"}</strong></span>
          <span><small>运行时间</small><strong>{formatRuntime(importPreview.summary?.elapsedSeconds ?? 0)}</strong></span>
          <span><small>实体</small><strong>{importPreview.state?.entities.length ?? 0}</strong></span>
          <span><small>科技</small><strong>{importPreview.summary?.completedTechCount ?? 0}</strong></span>
        </div>
        {importPreview.issues.length > 0 ? <ul>{importPreview.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
        <footer><button type="button" onClick={onCancelImport}>取消</button><button className="primary" type="button" onClick={onConfirmImport}><ShieldCheck size={14} />修复并导入</button></footer>
      </section> : null}
      <div className="save-slot-list">
        {([1, 2, 3] as SaveSlotId[]).map((slotId) => {
          const summary = summaryBySlot.get(slotId);
          return (
            <article className={`save-slot${summary ? " save-slot--occupied" : ""}${summary && !summary.valid ? " save-slot--invalid" : ""}`} key={slotId}>
              <i><HardDrive size={17} /></i>
              <div>
                <strong>本地槽位 {slotId}</strong>
                {summary ? (
                  <span>{new Date(summary.savedAt).toLocaleString("zh-CN")} · 科技 {summary.completedTechCount} · 结构 {summary.structurePoints} · {integrityLabel(summary.integrity)}</span>
                ) : <span>空槽位</span>}
              </div>
              <div className="save-slot-actions">
                <button type="button" onClick={() => onSaveSlot(slotId)} title={`保存到槽位 ${slotId}`} aria-label={`保存到槽位 ${slotId}`}><Save size={14} /></button>
                <button type="button" disabled={!summary?.valid} onClick={() => onLoadSlot(slotId)} title={`载入槽位 ${slotId}`} aria-label={`载入槽位 ${slotId}`}><Upload size={14} /></button>
                <button type="button" disabled={!summary} onClick={() => summary && setDeleteRequest({ kind: "slot", slotId, label: `本地槽位 ${slotId}`, details: `${new Date(summary.savedAt).toLocaleString("zh-CN")} · 运行 ${formatRuntime(summary.elapsedSeconds)} · 科技 ${summary.completedTechCount}` })} title={`删除槽位 ${slotId}`} aria-label={`删除槽位 ${slotId}`}><Trash2 size={14} /></button>
              </div>
            </article>
          );
        })}
      </div>
      <section className="save-snapshot-section">
        <header><div><History size={14} /><strong>恢复快照</strong><small>自动 {automaticSnapshotCount}/2 · 手动 {manualSnapshotCount}</small></div><span>可回滚</span></header>
        {snapshots.length === 0 ? <p className="save-empty-note">模拟运行后会自动保留最近快照</p> : <div className="save-snapshot-list">
          {snapshots.map((snapshot) => <article className={`save-snapshot-row${snapshot.valid ? "" : " save-snapshot-row--invalid"}`} key={snapshot.id}>
            <i>{snapshot.valid ? <ShieldCheck size={14} /> : <FileCheck2 size={14} />}</i>
            <div><strong>{snapshot.reason}</strong><span>{new Date(snapshot.savedAt).toLocaleTimeString("zh-CN")} · {formatRuntime(snapshot.elapsedSeconds)} · 科技 {snapshot.completedTechCount}</span></div>
            <button type="button" disabled={!snapshot.valid} onClick={() => onLoadSnapshot(snapshot.id)} title="回滚到此快照" aria-label={`回滚到快照 ${snapshot.id}`}><RotateCcw size={13} /></button>
            <button type="button" onClick={() => setDeleteRequest({ kind: "snapshot", snapshotId: snapshot.id, label: `快照：${snapshot.reason}`, details: `${new Date(snapshot.savedAt).toLocaleString("zh-CN")} · 运行 ${formatRuntime(snapshot.elapsedSeconds)} · 科技 ${snapshot.completedTechCount}` })} title="删除快照" aria-label={`删除快照 ${snapshot.id}`}><Trash2 size={13} /></button>
          </article>)}
        </div>}
      </section>
      <section className="content-pack-section">
        <header><div><FileCheck2 size={14} /><strong>内容包校验</strong></div><small>只读检查，不会修改核心目录</small></header>
        <div className="content-pack-actions"><button type="button" onClick={() => modInputRef.current?.click()}><Upload size={14} />选择内容包 JSON</button><button type="button" onClick={onExportModTemplate}><Download size={14} />导出模板</button></div>
        <input ref={modInputRef} type="file" accept="application/json,.json" aria-label="选择内容包文件" onChange={async (event) => { const file = event.target.files?.[0]; if (file) onValidateMod(await file.text()); event.target.value = ""; }} />
        {modValidation ? <div className={`content-pack-result${modValidation.valid ? " content-pack-result--valid" : " content-pack-result--invalid"}`}><strong>{modValidation.valid ? "内容包校验通过" : "内容包存在问题"}</strong><span>{modValidation.manifest?.name ?? "未识别内容包"} · 物品 {modValidation.counts.items} · 配方 {modValidation.counts.recipes} · 科技 {modValidation.counts.technologies}</span>{modValidation.issues.slice(0, 3).map((issue) => <small key={`${issue.code}-${issue.path}`}>{issue.severity === "error" ? "错误" : "提示"}：{issue.message}</small>)}</div> : null}
      </section>
      <SaveDeleteDialog target={deleteRequest} onCancel={() => setDeleteRequest(null)} onDelete={() => {
        if (!deleteRequest) return;
        if (deleteRequest.kind === "slot") onDeleteSlot(deleteRequest.slotId);
        else onDeleteSnapshot(deleteRequest.snapshotId);
        setDeleteRequest(null);
      }} />
    </div>
  );
}

function ContentPacksPanel({
  game,
  registry,
  validation,
  onValidate,
  onExportTemplate,
  onRegister,
  onSetEnabled,
  onRemove,
}: {
  game: GameState;
  registry: ContentPackRegistry;
  validation: ModValidationResult | null;
  onValidate: (raw: string) => void;
  onExportTemplate: () => void;
  onRegister: () => void;
  onSetEnabled: (packId: string, enabled: boolean) => void;
  onRemove: (packId: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const packs = Object.values(registry.packs).sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, "zh-CN"));
  return (
    <div className="operations-panel content-pack-manager">
      <header className="operations-section-header">
        <div><span>扩展内容目录</span><strong>内容包管理器</strong></div>
        <span className="settings-state"><PackagePlus size={14} />已注册 {packs.length}</span>
      </header>
      <section className="content-pack-importer">
        <div>
          <strong>注册新内容包</strong>
          <small>通过校验后可以直接写入本地注册表，并按依赖版本启用。</small>
        </div>
        <div className="content-pack-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={14} />选择 JSON</button>
          <button type="button" onClick={onExportTemplate}><Download size={14} />导出模板</button>
        </div>
        <input ref={fileInputRef} type="file" accept="application/json,.json" aria-label="选择要注册的内容包" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) onValidate(await file.text());
          event.target.value = "";
        }} />
        {validation ? <div className={`content-pack-registration${validation.valid ? " content-pack-registration--valid" : " content-pack-registration--invalid"}`}>
          <div><FileCheck2 size={15} /><span><strong>{validation.manifest?.name ?? "未识别内容包"}</strong><small>{validation.manifest?.id ?? "--"} · v{validation.manifest?.version ?? "--"}</small></span></div>
          <p>{validation.valid ? `物品 ${validation.counts.items} · 建筑 ${validation.counts.buildings} · 配方 ${validation.counts.recipes} · 科技 ${validation.counts.technologies}` : validation.issues.find((issue) => issue.severity === "error")?.message ?? "内容包格式无效"}</p>
          {validation.manifest?.dependencies?.length ? <span className="content-pack-preview-deps">依赖 {validation.manifest.dependencies.join(" · ")}</span> : null}
          <button type="button" disabled={!validation.valid} onClick={onRegister}><PackagePlus size={14} />注册并启用</button>
        </div> : null}
      </section>
      <section className="content-pack-list" aria-label="已注册内容包">
        {packs.length === 0 ? <div className="operations-empty content-pack-empty"><PackagePlus size={28} /><strong>还没有注册内容包</strong><span>导入通过校验的 JSON 后，它会成为可启用的实际内容目录。</span></div> : packs.map((pack) => {
          const dependencies = getContentPackDependencyStatuses(registry, pack.manifest);
          const usage = getContentPackUsage(game, pack.manifest);
          return <article className={`content-pack-card${pack.enabled ? " content-pack-card--enabled" : ""}`} key={pack.manifest.id}>
            <header>
              <i><PackagePlus size={16} /></i>
              <div><strong>{pack.manifest.name}</strong><span>{pack.manifest.id} · v{pack.manifest.version}{pack.manifest.author ? ` · ${pack.manifest.author}` : ""}</span></div>
              <em>{pack.enabled ? "已启用" : "已停用"}</em>
            </header>
            {pack.manifest.description ? <p>{pack.manifest.description}</p> : null}
            <div className="content-pack-counts"><span>物品 <strong>{pack.manifest.items?.length ?? 0}</strong></span><span>建筑 <strong>{pack.manifest.buildings?.length ?? 0}</strong></span><span>配方 <strong>{pack.manifest.recipes?.length ?? 0}</strong></span><span>科技 <strong>{pack.manifest.technologies?.length ?? 0}</strong></span></div>
            <div className="content-pack-dependencies"><strong>版本依赖</strong>{dependencies.length === 0 ? <span className="content-pack-dependency content-pack-dependency--ready"><CheckCircle2 size={12} />无外部依赖</span> : dependencies.map((dependency) => <span className={`content-pack-dependency${dependency.satisfied ? " content-pack-dependency--ready" : " content-pack-dependency--blocked"}`} key={dependency.specifier}>{dependency.satisfied ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{dependency.id}{dependency.range ? ` ${dependency.range}` : ""}<small>{dependency.satisfied ? `v${dependency.version}` : dependency.reason}</small></span>)}</div>
            <footer>
              <span className={usage.total > 0 ? "content-pack-usage content-pack-usage--used" : "content-pack-usage"}>{usage.total > 0 ? `存档引用：${usage.entries.join(" · ")}` : "当前存档未引用"}</span>
              <div><button type="button" onClick={() => onSetEnabled(pack.manifest.id, !pack.enabled)} title={pack.enabled ? "停用内容包" : "启用内容包"}><Power size={13} />{pack.enabled ? "停用" : "启用"}</button><button className="danger" type="button" onClick={() => onRemove(pack.manifest.id)} title="移除内容包" aria-label={`移除${pack.manifest.name}`}><Trash2 size={13} /></button></div>
            </footer>
          </article>;
        })}
      </section>
    </div>
  );
}

function SupportPanel({ game, report }: { game: GameState; report: AutomaticPerformanceReport | null }) {
  const [pwa, setPwa] = useState<PwaRuntimeState>(getPwaRuntimeState);
  const [cloudState, setCloudState] = useState<"checking" | "online" | "offline">("checking");
  const [cloudStatus, setCloudStatus] = useState<CloudPublicStatus | null>(null);
  const [feedbackKind, setFeedbackKind] = useState("experience");
  const [feedback, setFeedback] = useState("");
  const [feedbackState, setFeedbackState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [errorRevision, setErrorRevision] = useState(0);
  const errors = getClientErrors();
  void errorRevision;

  useEffect(() => subscribePwaRuntime(setPwa), []);
  useEffect(() => {
    let active = true;
    void resumeCloudSession().then((session) => {
      if (!active) return;
      setCloudState(session.status === "offline" ? "offline" : "online");
    });
    const refreshMetrics = async () => {
      const status = await fetchCloudPublicStatus().catch(() => null);
      if (active && status) setCloudStatus(status);
    };
    void refreshMetrics();
    const timer = window.setInterval(() => void refreshMetrics(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const diagnostics = () => collectClientDiagnostics(game, report);
  const submitFeedback = async () => {
    if (!feedback.trim()) return;
    setFeedbackState("sending");
    setFeedbackMessage(null);
    try {
      const id = await sendCloudFeedback(feedbackKind, feedback.trim(), diagnostics());
      setFeedback("");
      setFeedbackState("sent");
      setFeedbackMessage(`反馈已提交 · ${id.slice(0, 8)}`);
    } catch (error) {
      setFeedbackState("failed");
      setFeedbackMessage(`${error instanceof Error ? error.message : "提交失败"}，可先导出诊断包。`);
    }
  };

  return (
    <div className="operations-panel support-panel">
      <header className="operations-section-header">
        <div><span>发布与运行质量</span><strong>诊断反馈</strong></div>
        <span className={`settings-state support-cloud-state support-cloud-state--${cloudState}`}>{cloudState === "offline" ? <CloudOff size={14} /> : <Cloud size={14} />}{cloudState === "checking" ? "检测节点" : cloudState === "online" ? "云节点在线" : "云节点离线"}</span>
      </header>
      <section className="support-status-grid">
        <article><Bug size={18} /><span><small>本机错误记录</small><strong>{errors.length}</strong></span><button type="button" disabled={errors.length === 0} onClick={() => { clearClientErrors(); setErrorRevision((value) => value + 1); }}>清空</button></article>
        <article><Cloud size={18} /><span><small>今日进入工厂</small><strong>{cloudStatus?.players.today.toLocaleString("zh-CN") ?? "--"}</strong></span><em>{cloudStatus ? `${cloudStatus.timeZone} 日历` : "等待云节点"}</em></article>
        <article><Users size={18} /><span><small>累计游玩玩家</small><strong>{cloudStatus?.players.total.toLocaleString("zh-CN") ?? "--"}</strong></span><em>匿名标识去重</em></article>
        <article className="support-player-online"><Radio size={18} /><span><small>当前在线游玩</small><strong>{cloudStatus?.players.online.toLocaleString("zh-CN") ?? "--"}</strong></span><em>{cloudStatus ? `${cloudStatus.players.onlineWindowSeconds} 秒内活跃` : "等待云节点"}</em></article>
        <article><Smartphone size={18} /><span><small>PWA 状态</small><strong>{pwa.installed ? "已安装" : pwa.supported ? "浏览器运行" : "不可用"}</strong></span>{pwa.installAvailable ? <button type="button" onClick={() => void requestPwaInstall()}>安装</button> : null}</article>
        <article><RotateCcw size={18} /><span><small>网页版本</small><strong>v{__APP_VERSION__}</strong></span>{pwa.updateAvailable ? <button className="ready" type="button" onClick={applyPwaUpdate}>立即更新</button> : <em>已是最新</em>}</article>
      </section>
      <section className="support-diagnostics-export">
        <div><ShieldCheck size={16} /><span><strong>匿名诊断包</strong><small>环境、工厂规模、性能结果和最近错误，不包含密码与完整存档。</small></span></div>
        <button type="button" onClick={() => downloadDiagnostics(diagnostics())}><Download size={14} />导出 JSON</button>
      </section>
      <section className="support-feedback-form">
        <header><MessageSquare size={15} /><span><strong>提交反馈</strong><small>会附带同一份匿名诊断摘要</small></span></header>
        <div className="support-feedback-kind" role="group" aria-label="反馈类型">{[["experience", "体验"], ["bug", "故障"], ["balance", "数值"], ["mobile", "手机端"]].map(([id, label]) => <button className={feedbackKind === id ? "active" : ""} type="button" onClick={() => setFeedbackKind(id)} key={id}>{label}</button>)}</div>
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={4000} placeholder="描述出现的问题或建议" aria-label="反馈内容" />
        <footer><span className={feedbackState === "failed" ? "warning" : feedbackState === "sent" ? "ready" : ""}>{feedbackMessage ?? `${feedback.length}/4000`}</span><button className="primary" type="button" disabled={!feedback.trim() || feedbackState === "sending" || cloudState === "offline"} onClick={() => void submitFeedback()}>{feedbackState === "sending" ? <Activity size={14} /> : <Upload size={14} />}{feedbackState === "sending" ? "提交中" : "提交反馈"}</button></footer>
      </section>
      <section className="support-onboarding-reset"><GraduationCap size={16} /><span><strong>渐进教学</strong><small>重新打开从手动采矿到白糖、跨星物流与戴森云的 13 步教学。</small></span><button type="button" onClick={() => { resetOnboarding(); window.location.reload(); }}>重新开始教学</button></section>
    </div>
  );
}

export function OperationsWorkspace(props: OperationsWorkspaceProps) {
  if (!props.open) return null;
  const unlockedCount = props.game.achievements.unlockedIds.length;
  return (
    <section className="operations-workspace" role="dialog" aria-modal="true" aria-label="运营中心">
      <header className="operations-header">
        <div className="operations-title">
          <i><Gauge size={20} /></i>
          <div><span>星系运行协议</span><strong>运营中心</strong></div>
        </div>
        <div className="operations-summary">
          <span className={props.alerts.length > 0 ? "warning" : "positive"}><Bell size={13} />警报 <strong>{props.alerts.length}</strong></span>
          <span><Trophy size={13} />成就 <strong>{unlockedCount}/{ACHIEVEMENTS.length}</strong></span>
        </div>
        <button className="operations-close" type="button" onClick={props.onClose} title="关闭运营中心" aria-label="关闭运营中心"><X size={18} /></button>
      </header>
      <nav className="operations-tabs" role="tablist" aria-label="运营中心视图">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const count = tab.id === "alerts" ? props.alerts.length : tab.id === "achievements" ? unlockedCount : null;
          return (
            <button className={props.tab === tab.id ? "active" : ""} type="button" role="tab" aria-selected={props.tab === tab.id} key={tab.id} onClick={() => props.onTabChange(tab.id)}>
              <Icon size={15} /><span>{tab.label}</span>{count != null ? <strong>{count}</strong> : null}
            </button>
          );
        })}
      </nav>
      <div className="operations-body">
        {props.tab === "alerts" ? <AlertsPanel alerts={props.alerts} onSelect={props.onAlertSelect} /> : null}
        {props.tab === "achievements" ? <AchievementsPanel game={props.game} /> : null}
        {props.tab === "settings" ? <SettingsPanel game={props.game} report={props.performanceReport} desktopRelease={props.desktopRelease} onChange={props.onSettingsChange} onRunBenchmark={props.onRunBenchmark} onCheckDesktopUpdate={props.onCheckDesktopUpdate} onInstallDesktopUpdate={props.onInstallDesktopUpdate} onOpenReleaseNotes={props.onOpenReleaseNotes} /> : null}
        {props.tab === "saves" ? <SavesPanel {...props} /> : null}
        {props.tab === "packs" ? <ContentPacksPanel game={props.game} registry={props.contentPackRegistry} validation={props.modValidation} onValidate={props.onValidateMod} onExportTemplate={props.onExportModTemplate} onRegister={props.onRegisterContentPack} onSetEnabled={props.onSetContentPackEnabled} onRemove={props.onRemoveContentPack} /> : null}
        {props.tab === "support" ? <SupportPanel game={props.game} report={props.performanceReport} /> : null}
      </div>
    </section>
  );
}
