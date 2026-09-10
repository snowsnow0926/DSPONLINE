import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  Cloud,
  CloudOff,
  Download,
  ExternalLink,
  FileCheck2,
  Gauge,
  Github,
  GraduationCap,
  HardDrive,
  History,
  Languages,
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
  RefreshCw,
  Route,
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
import { PowerValue } from "./PowerValue";
import { useEffect, useRef, useState } from "react";
import { getPlanet } from "../game/content";
import { DIFFICULTY_DEFINITIONS } from "../game/difficulty";
import { getPlanetDisplayName } from "../game/galaxy";
import { ACHIEVEMENTS, getAchievementProgress } from "../game/progression";
import type { FactoryAlert } from "../game/alerts";
import { getLocalSaveStorageEstimate, type LocalSaveStorageEstimate, type SaveInspection, type SaveIntegrityStatus, type SaveSlotId, type SaveSlotSummary, type SaveSnapshotSummary } from "../game/storage";
import type { ModValidationResult } from "../game/mods";
import { getContentPackDependencyStatuses, getContentPackUsage, type ContentPackRegistry } from "../game/contentPacks";
import type { AutomaticPerformanceReport } from "../game/benchmark";
import { NativeUpdateCard } from "./NativeUpdateCard";
import type { AutosaveIntervalSeconds, CargoStackSize, DefaultBeltRouteMode, DifficultyMode, FontScale, GameSettings, GameState, SimulationSpeed } from "../game/types";
import { canSetBeltStackSize } from "../game/engine";
import { readSaveFileBytes } from "../game/saveFileCodec";
import { validateBuildingBufferLimitInput, validateDefaultBeltLanesInput, validateProliferatorBufferLimitInput, type BuildingBufferLimitValidation } from "../game/settings";
import { PRODUCTION_REFRESH_PROFILES, type ProductionRefreshPreference } from "../game/productionRefresh";
import { getPerformancePeaks, getPerformancePhaseShares, type PerformanceMonitorSnapshot } from "../game/performanceMonitor";
import type { LargeSaveAutosavePolicy } from "../game/largeSaveAutosavePolicy";
import { MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB, type MemoryAutoPauseThresholdMiB } from "../game/memoryBudget";
import { clearClientErrors, collectClientDiagnostics, downloadDiagnostics, getClientErrors } from "../game/diagnostics";
import { cloudApiBase, fetchCloudPublicStatus, resumeCloudSession, sendCloudFeedback, type CloudPublicStatus } from "../game/cloud";
import { playerDisplayAdjustment } from "../game/playerDisplayAdjustment";
import { resetOnboarding } from "../game/onboarding";
import { applyPwaUpdate, getPwaRuntimeState, requestPwaInstall, subscribePwaRuntime, type PwaRuntimeState } from "../pwa";
import { pwaUpdateStatusCopy } from "../pwaStatusCopy";
import { getCurrentReleaseNotes } from "../i18n/releaseNotes";
import { SaveDeleteDialog, type SaveDeleteTarget } from "./SaveDeleteDialog";
import { useAppLocale } from "../i18n/locale";
import { useGameDialog } from "./GameDialogProvider";
import { LogisticsManagementPanel, type LogisticsManagementPanelProps } from "./LogisticsManagementPanel";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { StableTextArea, clearStableTextDraft } from "./CompositionSafeInput";
import { WindowsNativePerformancePolicySetting } from "./WindowsNativePerformancePolicySetting";
import type { CanvasPerformanceFeatureId, CanvasPerformanceFeatures } from "../game/endgamePerformance";
import type {
  CanvasDetailPreference,
  CanvasDetailStage,
  CanvasInteractionDetailPreference,
  CanvasOverlapPreference,
} from "../game/canvasDensityPresentation";
import { CANVAS_FULL_ALL_MEDIUM_SAFETY_VISIBLE } from "../game/canvasDensityPresentation";
import { readSettingsCategoryPreference, writeSettingsCategoryPreference, type ConnectionHitArea, type ConnectionPointSize, type SettingsCategory } from "../game/uiPreferences";
import { deleteLocalSaveManagedEntries, dismissLocalSaveRecoveryPrompt, getLocalSaveWriterStatus, requestLocalSavePersistentStorage, subscribeLocalSaveStorageStatus, subscribeLocalSaveWriterStatus } from "../game/localSaveStore";
import { requestCurrentTabTakeover } from "../game/localSaveTakeover";

export type OperationsTab = "alerts" | "achievements" | "logistics" | "settings" | "performance" | "saves" | "packs" | "support";

interface OperationsWorkspaceProps {
  open: boolean;
  tab: OperationsTab;
  game: GameState;
  alerts: FactoryAlert[];
  alertCount: number;
  slots: SaveSlotSummary[];
  snapshots: SaveSnapshotSummary[];
  importPreview: SaveInspection | null;
  modValidation: ModValidationResult | null;
  contentPackRegistry: ContentPackRegistry;
  performanceReport: AutomaticPerformanceReport | null;
  productionRefreshPreference: ProductionRefreshPreference;
  productionRefreshIntervalMs: number;
  endgameExtremeMode: boolean;
  onEndgameExtremeModeChange: (enabled: boolean) => void;
  connectExpandAll: boolean;
  onConnectExpandAllChange: (enabled: boolean) => void;
  fullRealtimeSimulation: boolean;
  onFullRealtimeSimulationChange: (enabled: boolean) => void;
  factoryAlertsEnabled: boolean;
  onFactoryAlertsEnabledChange: (enabled: boolean) => void;
  largeSaveAutosaveProtection: boolean;
  largeSaveAutosavePolicy: LargeSaveAutosavePolicy;
  onLargeSaveAutosaveProtectionChange: (enabled: boolean) => void;
  memoryAutoPauseEnabled: boolean;
  memoryAutoPauseThresholdMiB: MemoryAutoPauseThresholdMiB;
  onMemoryAutoPauseEnabledChange: (enabled: boolean) => void;
  onMemoryAutoPauseThresholdChange: (thresholdMiB: MemoryAutoPauseThresholdMiB) => void;
  windowsNativeCoreAvailable: boolean;
  windowsNativeCoreBetaEnabled: boolean;
  windowsNativeCoreBetaStatus: "disabled" | "awaiting-checkpoint" | "hashing" | "shadow-active" | "native-ready" | "diverged" | "unavailable" | "failed";
  onWindowsNativeCoreBetaEnabledChange: (enabled: boolean) => void;
  allowEditsDuringSave: boolean;
  onAllowEditsDuringSaveChange: (enabled: boolean) => void;
  blueprintAllowOverlap: boolean;
  onBlueprintAllowOverlapChange: (enabled: boolean) => void;
  canvasDetailPreference: CanvasDetailPreference;
  canvasOverlapPreference: CanvasOverlapPreference;
  canvasInteractionDetailPreference: CanvasInteractionDetailPreference;
  canvasDetailStage: CanvasDetailStage;
  canvasVisibleNodeCount: number;
  canvasStackGroupCount: number;
  canvasStackHiddenCount: number;
  onCanvasDetailPreferenceChange: (preference: CanvasDetailPreference) => void;
  onCanvasOverlapPreferenceChange: (preference: CanvasOverlapPreference) => void;
  onCanvasInteractionDetailPreferenceChange: (preference: CanvasInteractionDetailPreference) => void;
  canvasPerformanceFeatures: CanvasPerformanceFeatures;
  onCanvasPerformanceFeatureChange: (id: CanvasPerformanceFeatureId, enabled: boolean) => void;
  lineFindMode: boolean;
  connectionPointSize: ConnectionPointSize;
  connectionHitArea: ConnectionHitArea;
  defaultBeltLanes: number;
  showRunLog: boolean;
  showItemHover: boolean;
  onLineFindModeChange: (enabled: boolean) => void;
  onConnectionPointSizeChange: (size: ConnectionPointSize) => void;
  onConnectionHitAreaChange: (size: ConnectionHitArea) => void;
  onDefaultBeltLanesChange: (lanes: number) => void;
  onRunLogChange: (enabled: boolean) => void;
  onItemHoverChange: (enabled: boolean) => void;
  performanceMonitor: PerformanceMonitorSnapshot;
  onProductionRefreshPreferenceChange: (preference: ProductionRefreshPreference) => void;
  onStartPerformanceMonitor: () => void;
  onStopPerformanceMonitor: () => void;
  onClearPerformanceMonitor: () => void;
  onExportPerformanceMonitor: () => void;
  onClose: () => void;
  onTabChange: (tab: OperationsTab) => void;
  onAlertSelect: (alert: FactoryAlert) => void;
  onSettingsChange: (settings: Partial<GameSettings>) => void;
  onManualSave: () => void;
  onExport: () => void;
  /** Accept text for cloud/legacy callers or transferred local-file bytes. */
  onImport: (payload: string | ArrayBuffer) => void;
  onConfirmImport: () => void;
  onConfirmImportRescue: () => void;
  importRescueArmed: boolean;
  onCancelImport: () => void;
  onSaveSlot: (slotId: SaveSlotId) => void;
  onLoadSlot: (slotId: SaveSlotId) => void;
  onDeleteSlot: (slotId: SaveSlotId) => void;
  onCreateSnapshot: () => void;
  onAddSecondUnipolarVein: () => void;
  unipolarExpansionBusy: boolean;
  onLoadSnapshot: (snapshotId: string) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
  onDeleteSnapshots: (snapshotIds: string[]) => void;
  onRunBenchmark: () => void;
  onOpenReleaseNotes: () => void;
  onOpenTutorial: (sectionId?: string) => void;
  onValidateMod: (raw: string) => void;
  onExportModTemplate: () => void;
  onRegisterContentPack: () => void;
  onSetContentPackEnabled: (packId: string, enabled: boolean) => void;
  onRemoveContentPack: (packId: string) => void;
  logisticsActions: Omit<LogisticsManagementPanelProps, "game">;
}

const TABS: Array<{ id: OperationsTab; label: string; icon: typeof Bell }> = [
  { id: "alerts", label: "警报", icon: Bell },
  { id: "achievements", label: "成就", icon: Trophy },
  { id: "logistics", label: "物流管理", icon: Route },
  { id: "settings", label: "设置", icon: Settings2 },
  { id: "performance", label: "性能", icon: Activity },
  { id: "saves", label: "存档", icon: HardDrive },
  { id: "packs", label: "内容包", icon: PackagePlus },
  { id: "support", label: "诊断反馈", icon: MessageSquare },
];

const PROJECT_SOURCE_URL = "https://github.com/snowsnow0926/DSPONLINE";

function formatRuntime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function AlertsPanel({ alerts, enabled, onSelect, onOpenTutorial }: { alerts: FactoryAlert[]; enabled: boolean; onSelect: (alert: FactoryAlert) => void; onOpenTutorial: (sectionId?: string) => void }) {
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
      {!enabled ? (
        <div className="operations-empty">
          <Bell size={28} />
          <strong>工厂运行警报已关闭</strong>
          <span>可在“设置 → 性能”重新开启；关闭时不会扫描全星区设备状态</span>
        </div>
      ) : alerts.length === 0 ? (
        <div className="operations-empty">
          <CheckCircle2 size={28} />
          <strong>生产网络运行正常</strong>
          <span>当前没有需要处理的设备警报</span>
          <button type="button" onClick={() => onOpenTutorial("troubleshooting")}><GraduationCap size={14} />查看排障教程</button>
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
          <button className="operations-tutorial-link" type="button" onClick={() => onOpenTutorial("troubleshooting")}><GraduationCap size={14} />打开常见故障排查教程</button>
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

const BUFFER_LIMIT_PRESETS = [10_000, 100_000, 1_000_000] as const;
const BUFFER_LIMIT_LABELS: Record<(typeof BUFFER_LIMIT_PRESETS)[number], string> = {
  10_000: "1万",
  100_000: "10万",
  1_000_000: "100万",
};

function BufferLimitSetting({ label, value, onChange, presets = BUFFER_LIMIT_PRESETS, labels = BUFFER_LIMIT_LABELS, rangeLabel = "1,000～100,000,000", validate = validateBuildingBufferLimitInput, help = "按每一种输入、输出或物流槽独立限制；调低不会删除已有库存。" }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  presets?: readonly number[];
  labels?: Record<number, string>;
  rangeLabel?: string;
  validate?: (raw: string) => BuildingBufferLimitValidation;
  help?: string;
}) {
  const preset = presets.includes(value);
  const [customEditing, setCustomEditing] = useState(!preset);
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(String(value));
    setCustomEditing(!presets.includes(value));
    setError(null);
  }, [value]);
  const submit = () => {
    const result = validate(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
    onChange(result.value);
  };
  return <section className="settings-group settings-buffer-limit">
    <header><HardDrive size={14} /><span>{label}</span><small>{value.toLocaleString("zh-CN")}/种</small></header>
    <div className="settings-segmented settings-buffer-presets" aria-label={`${label}预设`}>
      {presets.map((option) => <button className={!customEditing && value === option ? "active" : ""} type="button" key={option} aria-pressed={!customEditing && value === option} onClick={() => { setCustomEditing(false); setError(null); onChange(option); }}>{labels[option] ?? option.toLocaleString("zh-CN")}</button>)}
      <button className={customEditing || !preset ? "active" : ""} type="button" aria-pressed={customEditing || !preset} onClick={() => { setCustomEditing(true); setDraft(String(value)); setError(null); }}>自定义</button>
    </div>
    {customEditing || !preset ? <div className="settings-buffer-custom">
      <label><span>{rangeLabel}</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={draft} onChange={(event) => { setDraft(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} aria-invalid={Boolean(error)} aria-label={`${label}自定义值`} /></label>
      <button type="button" onClick={submit}>应用</button>
    </div> : null}
    {error ? <p className="settings-buffer-error" role="alert">{error}</p> : <p className="settings-help">{help}</p>}
  </section>;
}

function DefaultBeltLanesSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const presets = [1, 2, 4] as const;
  const preset = presets.includes(value as (typeof presets)[number]);
  const [customEditing, setCustomEditing] = useState(!preset);
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(String(value));
    setCustomEditing(!presets.includes(value as (typeof presets)[number]));
    setError(null);
  }, [value]);
  const submit = () => {
    const result = validateDefaultBeltLanesInput(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
    onChange(result.value);
  };
  return <div className="settings-belt-lanes">
    <label><span>默认并联数量</span><strong>{value.toLocaleString("zh-CN")} / 4,096</strong></label>
    <div className="settings-segmented" aria-label="新建传送带默认并联数量">
      {presets.map((lanes) => <button className={!customEditing && value === lanes ? "active" : ""} type="button" aria-pressed={!customEditing && value === lanes} key={lanes} onClick={() => { setCustomEditing(false); setError(null); onChange(lanes); }}>×{lanes}</button>)}
      <button className={customEditing || !preset ? "active" : ""} type="button" aria-pressed={customEditing || !preset} onClick={() => { setCustomEditing(true); setDraft(String(value)); setError(null); }}>自定义</button>
    </div>
    {customEditing || !preset ? <div className="settings-buffer-custom">
      <label><span>1～4,096</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={draft} onChange={(event) => { setDraft(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} aria-invalid={Boolean(error)} aria-label="新建传送带默认并联数量自定义值" /></label>
      <button type="button" onClick={submit}>应用</button>
    </div> : null}
    <button className="settings-reset-inline" type="button" disabled={value === 1} onClick={() => onChange(1)}><RotateCcw size={13} />恢复默认 ×1</button>
    {error ? <p className="settings-buffer-error" role="alert">{error}</p> : null}
  </div>;
}

function SettingsPanel({ game, report, productionRefreshPreference, productionRefreshIntervalMs, endgameExtremeMode, connectExpandAll, fullRealtimeSimulation, factoryAlertsEnabled, largeSaveAutosaveProtection, largeSaveAutosavePolicy, memoryAutoPauseEnabled, memoryAutoPauseThresholdMiB, blueprintAllowOverlap, canvasDetailPreference, canvasOverlapPreference, canvasInteractionDetailPreference, canvasDetailStage, canvasVisibleNodeCount, canvasStackGroupCount, canvasStackHiddenCount, canvasPerformanceFeatures, onEndgameExtremeModeChange, onConnectExpandAllChange, onFullRealtimeSimulationChange, onFactoryAlertsEnabledChange, onLargeSaveAutosaveProtectionChange, onMemoryAutoPauseEnabledChange, onMemoryAutoPauseThresholdChange, allowEditsDuringSave, onAllowEditsDuringSaveChange, onBlueprintAllowOverlapChange, onCanvasDetailPreferenceChange, onCanvasOverlapPreferenceChange, onCanvasInteractionDetailPreferenceChange, onCanvasPerformanceFeatureChange, lineFindMode, onLineFindModeChange, connectionPointSize, onConnectionPointSizeChange, connectionHitArea, onConnectionHitAreaChange, defaultBeltLanes, onDefaultBeltLanesChange, showRunLog, onRunLogChange, showItemHover, onItemHoverChange, onProductionRefreshPreferenceChange, onChange, onRunBenchmark, onOpenReleaseNotes, onOpenTutorial }: { game: GameState; report: AutomaticPerformanceReport | null; productionRefreshPreference: ProductionRefreshPreference; productionRefreshIntervalMs: number; endgameExtremeMode: boolean; connectExpandAll: boolean; fullRealtimeSimulation: boolean; factoryAlertsEnabled: boolean; largeSaveAutosaveProtection: boolean; largeSaveAutosavePolicy: LargeSaveAutosavePolicy; memoryAutoPauseEnabled: boolean; memoryAutoPauseThresholdMiB: MemoryAutoPauseThresholdMiB; blueprintAllowOverlap: boolean; canvasDetailPreference: CanvasDetailPreference; canvasOverlapPreference: CanvasOverlapPreference; canvasInteractionDetailPreference: CanvasInteractionDetailPreference; canvasDetailStage: CanvasDetailStage; canvasVisibleNodeCount: number; canvasStackGroupCount: number; canvasStackHiddenCount: number; canvasPerformanceFeatures: CanvasPerformanceFeatures; onEndgameExtremeModeChange: (enabled: boolean) => void; onConnectExpandAllChange: (enabled: boolean) => void; onFullRealtimeSimulationChange: (enabled: boolean) => void; onFactoryAlertsEnabledChange: (enabled: boolean) => void; onLargeSaveAutosaveProtectionChange: (enabled: boolean) => void; onMemoryAutoPauseEnabledChange: (enabled: boolean) => void; onMemoryAutoPauseThresholdChange: (thresholdMiB: MemoryAutoPauseThresholdMiB) => void; allowEditsDuringSave: boolean; onAllowEditsDuringSaveChange: (enabled: boolean) => void; onBlueprintAllowOverlapChange: (enabled: boolean) => void; onCanvasDetailPreferenceChange: (preference: CanvasDetailPreference) => void; onCanvasOverlapPreferenceChange: (preference: CanvasOverlapPreference) => void; onCanvasInteractionDetailPreferenceChange: (preference: CanvasInteractionDetailPreference) => void; onCanvasPerformanceFeatureChange: (id: CanvasPerformanceFeatureId, enabled: boolean) => void; lineFindMode: boolean; onLineFindModeChange: (enabled: boolean) => void; connectionPointSize: ConnectionPointSize; onConnectionPointSizeChange: (size: ConnectionPointSize) => void; connectionHitArea: ConnectionHitArea; onConnectionHitAreaChange: (size: ConnectionHitArea) => void; defaultBeltLanes: number; onDefaultBeltLanesChange: (lanes: number) => void; showRunLog: boolean; onRunLogChange: (enabled: boolean) => void; showItemHover: boolean; onItemHoverChange: (enabled: boolean) => void; onProductionRefreshPreferenceChange: (preference: ProductionRefreshPreference) => void; onChange: (settings: Partial<GameSettings>) => void; onRunBenchmark: () => void; onOpenReleaseNotes: () => void; onOpenTutorial: () => void }) {
  const { settings } = game;
  const { locale, setLocale } = useAppLocale();
  const currentReleaseNotes = getCurrentReleaseNotes(locale);
  const gameDialog = useGameDialog();
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(readSettingsCategoryPreference);
  const [localSaveWriterStatus, setLocalSaveWriterStatus] = useState(getLocalSaveWriterStatus);
  const [localSaveTakeoverBusy, setLocalSaveTakeoverBusy] = useState(false);
  const [localSaveTakeoverMessage, setLocalSaveTakeoverMessage] = useState<string | null>(null);
  useEffect(() => { writeSettingsCategoryPreference(settingsCategory); }, [settingsCategory]);
  useEffect(() => subscribeLocalSaveWriterStatus(setLocalSaveWriterStatus), []);
  const canvasPerformanceCopy = locale === "en"
    ? {
        ariaLabel: "Independent canvas optimization fallbacks",
        items: [
          ["renderProjection", "Lightweight planet snapshot", "Safe optimization"],
          ["topologyCache", "Topology and route cache", "Safe optimization"],
          ["spatialIndexes", "Port and alignment spatial index", "Safe optimization"],
          ["extremeVisuals", "Reduce animation and routine labels", "Extreme mode only"],
          ["nodeLod", "True compact node LOD", "Extreme mode only"],
          ["canvasBelts", "Canvas batch belts", "Extreme mode only"],
          ["viewportCulling", "Stronger viewport culling", "Extreme mode only"],
          ["minimapThrottle", "Low-frequency minimap snapshot", "Extreme mode only"],
        ] as Array<[CanvasPerformanceFeatureId, string, string]>,
        help: "Each switch can be disabled independently; disabled features fall back to the current React Flow path. Visual reductions are inactive while extreme mode is off.",
      }
      : {
        ariaLabel: "画布优化独立回退开关",
        items: [
          ["renderProjection", "当前星球轻量快照", "安全优化"],
          ["topologyCache", "拓扑与路线缓存", "安全优化"],
          ["spatialIndexes", "对齐与端口空间索引", "安全优化"],
          ["extremeVisuals", "减少动画与普通标签", "仅极限模式"],
          ["nodeLod", "真正的紧凑节点 LOD", "仅极限模式"],
          ["canvasBelts", "Canvas 批量线路", "仅极限模式"],
          ["viewportCulling", "强化视口裁剪", "仅极限模式"],
          ["minimapThrottle", "小地图低频快照", "仅极限模式"],
        ] as Array<[CanvasPerformanceFeatureId, string, string]>,
        help: "每项开关都可独立关闭；关闭后回退到当前 React Flow 路径。视觉降级项在极限模式关闭时不会生效。",
      };
  const formatAutosaveInterval = (seconds: number) => seconds === 0
    ? (locale === "en" ? "Off" : "关闭")
    : seconds >= 60
      ? `${seconds / 60} ${locale === "en" ? "min" : "分钟"}`
      : `${seconds} ${locale === "en" ? "s" : "秒"}`;
  const autosaveSizeLabel = largeSaveAutosavePolicy.persistedByteLength === null
    ? (locale === "en" ? "size unknown" : "大小未知")
    : `${(largeSaveAutosavePolicy.persistedByteLength / (1024 * 1024)).toFixed(1)} MiB`;
  const memoryThresholdLabel = memoryAutoPauseThresholdMiB === null
    ? (locale === "en" ? "Auto · 90% of browser heap" : "自动 · 浏览器堆上限 90%")
    : `${memoryAutoPauseThresholdMiB >= 1_024 ? `${memoryAutoPauseThresholdMiB / 1_024} GiB` : `${memoryAutoPauseThresholdMiB} MiB`}`;
  return (
    <div className="operations-panel operations-settings" data-settings-category={settingsCategory}>
      <header className="operations-section-header">
        <div><span>模拟参数</span><strong>运行设置</strong></div>
        <span className="settings-state"><Gauge size={14} />{settings.simulationSpeed}× 模拟</span>
      </header>
      <nav className="settings-category-tabs" aria-label="设置分类">
        {([
          ["all", "全部"],
          ["visual", "画面与主题"],
          ["performance", "终局性能"],
          ["interaction", "交互与控制"],
          ["storage", "存档与云同步"],
          ["statistics", "统计与运行记录"],
          ["other", "教程、版本与其他"],
        ] as Array<[SettingsCategory, string]>).map(([id, label]) => <button type="button" className={settingsCategory === id ? "active" : ""} aria-pressed={settingsCategory === id} key={id} onClick={() => setSettingsCategory(id)}>{label}</button>)}
      </nav>
      <p className="settings-category-hint">分类只影响本机设置页面的显示，不会改变存档内容；返回后会保留上次分类。</p>
      {settingsCategory === "all" ? <section className="settings-category-overview" aria-label="设置分类总览">
        {([
          ["visual", "画面与主题", "亮色/深色、字体、语言和默认画布显示"],
          ["performance", "终局性能", "刷新频率、极限模式与独立画布回退开关"],
          ["interaction", "交互与控制", "线路、缺料跳转、寻线和输入行为"],
          ["storage", "存档与云同步", "自动保存、资源模式和存档保护"],
          ["statistics", "统计与运行记录", "性能采样、运行记录和诊断报告"],
          ["other", "教程、版本与其他", "教程入口、版本记录、难度与社区"],
        ] as Array<[Exclude<SettingsCategory, "all">, string, string]>).map(([id, label, detail]) => <button type="button" key={id} onClick={() => setSettingsCategory(id)}>
          <span><strong>{label}</strong><small>{detail}</small></span><ChevronRight size={16} aria-hidden="true" />
        </button>)}
        <section className="settings-category-quick" aria-label="界面主题">
          <header><Palette size={14} /><span>界面主题</span><small>{{ dark: "深色", light: "亮色", system: "跟随系统" }[settings.theme]}</small></header>
          <div className="settings-segmented" aria-label="主题快速设置">
            {(["dark", "light", "system"] as const).map((theme) => <button className={settings.theme === theme ? "active" : ""} type="button" key={theme} aria-pressed={settings.theme === theme} onClick={() => onChange({ theme })}>{{ dark: "深色", light: "亮色", system: "跟随系统" }[theme]}</button>)}
          </div>
        </section>
      </section> : <button className="settings-category-back" type="button" onClick={() => setSettingsCategory("all")}><ChevronLeft size={15} />返回设置分类</button>}
      <section className="settings-group" data-settings-category="visual">
        <header><Zap size={14} /><span>模拟速度</span></header>
        <div className="settings-segmented" aria-label="模拟速度">
          {([1, 2, 4] as SimulationSpeed[]).map((speed) => (
            <button className={settings.simulationSpeed === speed ? "active" : ""} type="button" key={speed} onClick={() => onChange({ simulationSpeed: speed })}>{speed}×</button>
          ))}
        </div>
      </section>
      <section className="settings-group" data-settings-category="visual">
        <header><Type size={14} /><span>字体大小</span><small>{Math.round(settings.fontScale * 100)}%</small></header>
        <div className="settings-segmented" aria-label="字体大小">
          {([0.8, 1, 1.25, 1.5, 2] as FontScale[]).map((scale) => (
            <button className={settings.fontScale === scale ? "active" : ""} type="button" key={scale} aria-pressed={settings.fontScale === scale} onClick={() => onChange({ fontScale: scale })}>{Math.round(scale * 100)}%</button>
          ))}
        </div>
      </section>
      <section className="settings-group" data-settings-category="visual">
        <header><Palette size={14} /><span>界面主题</span><small>{{ dark: "深色", light: "亮色", system: "跟随系统" }[settings.theme]}</small></header>
        <div className="settings-segmented" aria-label={settingsCategory === "all" ? "界面主题详情" : "界面主题"}>
          {(["dark", "light", "system"] as const).map((theme) => <button className={settings.theme === theme ? "active" : ""} type="button" key={theme} onClick={() => onChange({ theme })}>{{ dark: "深色", light: "亮色", system: "跟随系统" }[theme]}</button>)}
        </div>
      </section>
      <section className="settings-group" data-settings-category="visual">
        <header><Languages size={14} /><span>语言</span><small>{locale === "en" ? "English" : "简体中文"}</small></header>
        <div className="settings-segmented" aria-label="语言">
          <button className={locale === "zh-CN" ? "active" : ""} type="button" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>简体中文</button>
          <button className={locale === "en" ? "active" : ""} type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
        </div>
        <p className="settings-help">语言仅保存在当前设备，不会写入游戏存档或云存档。</p>
      </section>
      <section className="settings-group" data-settings-category="visual">
        <header><Settings2 size={14} /><span>科技树布局</span><small>{settings.technologyLayout === "compact" ? "精简" : "标准"}</small></header>
        <div className="settings-segmented" aria-label="科技树布局">
          <button className={settings.technologyLayout === "standard" ? "active" : ""} type="button" onClick={() => onChange({ technologyLayout: "standard" })}>标准模式</button>
          <button className={settings.technologyLayout === "compact" ? "active" : ""} type="button" onClick={() => onChange({ technologyLayout: "compact" })}>精简模式</button>
        </div>
      </section>
      <section className="settings-group settings-belt-defaults" data-settings-category="visual interaction">
        <header><Settings2 size={14} /><span>新建传送带默认参数</span><small>仅影响新线路</small></header>
        <DefaultBeltLanesSetting value={defaultBeltLanes} onChange={onDefaultBeltLanesChange} />
        <label><span>货物堆叠</span><div className="settings-segmented" aria-label="新建传送带默认货物堆叠">{([1, 2, 4] as CargoStackSize[]).map((stackSize) => <button className={settings.defaultBeltStackSize === stackSize ? "active" : ""} type="button" disabled={!canSetBeltStackSize(game, stackSize)} key={stackSize} onClick={() => onChange({ defaultBeltStackSize: stackSize })}>×{stackSize}</button>)}</div></label>
        <label><span>线路形状</span><div className="settings-segmented" aria-label="新建传送带默认线路形状">{(["auto", "bezier", "upper", "lower"] as DefaultBeltRouteMode[]).map((mode) => <button className={settings.defaultBeltRouteMode === mode ? "active" : ""} type="button" key={mode} onClick={() => onChange({ defaultBeltRouteMode: mode })}>{{ auto: "自动避让", bezier: "曲线", upper: "上绕", lower: "下绕" }[mode]}</button>)}</div></label>
        <p className="settings-help">新线路会一次性消耗对应数量的同级传送带；材料不足时整条线路不会建立。蓝图保留高于默认值的并联数量，未解锁的货物堆叠等级不可选择。</p>
      </section>
      <section className="settings-group" data-settings-category="interaction">
        <header><MousePointer2 size={14} /><span>建筑连接点与连线圆圈</span><small>视觉大小</small></header>
        <div className="settings-segmented" role="radiogroup" aria-label="建筑连接点尺寸">
          {(["default", "large25", "large50"] as const).map((size) => <button
            type="button"
            key={size}
            className={connectionPointSize === size ? "active" : ""}
            aria-pressed={connectionPointSize === size}
            onClick={() => onConnectionPointSizeChange(size)}
          >{size === "default" ? "默认" : size === "large25" ? "放大 25%" : "放大 50%"}</button>)}
        </div>
        <p className="settings-help">只调整可见端口和连接预览大小；仅保存在本机，不进入存档。</p>
        <header><MousePointer2 size={14} /><span>接口真实命中范围</span><small>{connectionHitArea === "auto" ? "自动适配（推荐）" : connectionHitArea === "standard" ? "标准" : connectionHitArea === "large" ? "放大" : "超大"}</small></header>
        <div className="settings-segmented" role="radiogroup" aria-label="建筑接口真实命中范围">
          {(["auto", "standard", "large", "huge"] as const).map((size) => <button type="button" key={size} className={connectionHitArea === size ? "active" : ""} aria-pressed={connectionHitArea === size} onClick={() => onConnectionHitAreaChange(size)}>{{ auto: "自动适配", standard: "标准", large: "放大", huge: "超大" }[size]}</button>)}
        </div>
        <p className="settings-help">透明命中区域不会遮挡建筑文字。自动档随缩放扩大；触控设备始终保证至少 56px 命中直径。</p>
      </section>
      <section className="settings-group settings-toggle-list" data-settings-category="interaction">
        <ToggleSetting
          checked={blueprintAllowOverlap}
          label={locale === "en" ? "Allow overlapping placement" : "允许重叠放置"}
          value={blueprintAllowOverlap
            ? locale === "en" ? "Blueprints and dragging may share the same snapped position" : "蓝图与拖动均可使用同一吸附坐标"
            : locale === "en" ? "Blueprints and dragging both reject exact overlaps" : "蓝图与拖动均拒绝精确重叠"}
          icon={<MousePointer2 size={16} />}
          onChange={onBlueprintAllowOverlapChange}
        />
        <p className={blueprintAllowOverlap ? "settings-warning" : "settings-help"} role={blueprintAllowOverlap ? "alert" : undefined}>{locale === "en"
          ? "Device-only and off by default. Overlapping buildings remain separate entities and may appear as a canvas stack; saves and machine counts are never merged."
          : "仅保存在当前设备且默认关闭。重叠建筑仍是独立实体，画布可能将其显示为堆叠；不会合并存档或机器数量。"}</p>
      </section>
      <div data-settings-category="performance">
      <BufferLimitSetting label="生产建筑缓存上限" value={settings.productionBufferLimit} onChange={(productionBufferLimit) => onChange({ productionBufferLimit })} />
      <BufferLimitSetting label="仓储与物流建筑缓存上限" value={settings.logisticsBufferLimit} onChange={(logisticsBufferLimit) => onChange({ logisticsBufferLimit })} />
      <BufferLimitSetting label="传送带转运额度上限" value={settings.beltBufferLimit} onChange={(beltBufferLimit) => onChange({ beltBufferLimit })} help="限制大时间步内每条线路累计的转运额度，不改变每秒吞吐，也不是线路中的实际货物库存。" />
      <BufferLimitSetting
        label="增产剂缓存上限"
        value={settings.proliferatorBufferLimit}
        onChange={(proliferatorBufferLimit) => onChange({ proliferatorBufferLimit })}
        presets={[120, 600, 3_000, 1_000_000]}
        labels={{ 120: "120", 600: "600", 3_000: "3,000", 1_000_000: "100万" }}
        rangeLabel="1～100,000,000"
        validate={validateProliferatorBufferLimitInput}
        help="只限制已安装喷涂机当前等级的增产剂物品；内部喷涂点和既有超额库存不会被删除。"
      />
      </div>
      <section className="settings-group settings-memory-guard" data-settings-category="performance">
        <header><ShieldCheck size={14} /><span>{locale === "en" ? "Memory and backlog auto-pause" : "内存与积压自动暂停"}</span><small>{memoryAutoPauseEnabled ? memoryThresholdLabel : locale === "en" ? "Off" : "关闭"}</small></header>
        <ToggleSetting
          checked={memoryAutoPauseEnabled}
          label={locale === "en" ? "Pause automatically on memory or backlog pressure" : "内存或模拟积压超限时自动暂停"}
          value={memoryAutoPauseEnabled
            ? locale === "en" ? `Device-only · ${memoryThresholdLabel}` : `仅本机 · ${memoryThresholdLabel}`
            : locale === "en" ? "Off; no automatic pause" : "关闭；不自动暂停"}
          icon={<ShieldCheck size={16} />}
          onChange={onMemoryAutoPauseEnabledChange}
        />
        <div className="settings-segmented" role="radiogroup" aria-label={locale === "en" ? "Memory auto-pause threshold" : "自动暂停内存阈值"}>
          <button type="button" role="radio" aria-checked={memoryAutoPauseThresholdMiB === null} className={memoryAutoPauseThresholdMiB === null ? "active" : ""} onClick={() => onMemoryAutoPauseThresholdChange(null)}>{locale === "en" ? "Auto 90%" : "自动 90%"}</button>
          {MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB.map((thresholdMiB) => {
            const label = thresholdMiB >= 1_024 ? `${thresholdMiB / 1_024} GiB` : `${thresholdMiB} MiB`;
            return <button type="button" role="radio" aria-checked={memoryAutoPauseThresholdMiB === thresholdMiB} className={memoryAutoPauseThresholdMiB === thresholdMiB ? "active" : ""} onClick={() => onMemoryAutoPauseThresholdChange(thresholdMiB)} key={thresholdMiB}>{label}</button>;
          })}
        </div>
        <p className={memoryAutoPauseEnabled ? "settings-help" : "settings-warning"} role={memoryAutoPauseEnabled ? undefined : "alert"}>{memoryAutoPauseEnabled
          ? locale === "en"
            ? "Device-only; it never enters saves or cloud sync. Auto uses the browser JS heap limit. A fixed value pauses the current visible state at that watermark without installing an older checkpoint."
            : "仅保存在当前设备，不进入存档或云同步。自动档使用浏览器 JS 堆上限；固定档达到水位时暂停当前可见进度，不再安装旧检查点。"
          : locale === "en"
            ? "Memory and simulation-backlog auto-pause is off. The current state and unsubmitted simulation time continue past the normal watermarks, so the browser may freeze or crash. Worker protocol/checkpoint failures and allocation failures can still stop the game to protect save integrity; export a backup first."
            : "已关闭内存与模拟积压自动暂停。超过堆内存或 24 秒积压线时会继续使用当前状态和未提交时间；浏览器可能卡死或崩溃。Worker 协议/检查点失败和内存分配失败仍可能为保护存档而停止，请先导出备份。"}</p>
      </section>
      <section className="settings-group settings-production-refresh" data-settings-category="performance">
        <header><Gauge size={14} /><span>生产画面刷新频率</span><small>{productionRefreshIntervalMs < 1_000 ? `${productionRefreshIntervalMs} ms` : `${productionRefreshIntervalMs / 1_000} 秒`}</small></header>
        <div className="production-refresh-options" role="radiogroup" aria-label="生产画面刷新频率">
          {PRODUCTION_REFRESH_PROFILES.map((profile) => <button className={productionRefreshPreference === profile.id ? "active" : ""} type="button" role="radio" aria-checked={productionRefreshPreference === profile.id} key={profile.id} onClick={() => onProductionRefreshPreferenceChange(profile.id)}>
            <span>{profile.label}{profile.id === "auto" ? <em>推荐</em> : null}</span><small>{profile.summary}</small>
          </button>)}
        </div>
        <p className="settings-help">只调整生产画面与状态发布节奏，不改变模拟时间、产量、物流、科研或戴森工程。固定档位不会被自动调节覆盖。</p>
      </section>
      <section className="settings-group settings-canvas-detail" data-settings-category="performance visual">
        <header><Gauge size={14} /><span>{locale === "en" ? "Canvas detail" : "画布细节"}</span><small>{canvasDetailStage === "full" ? locale === "en" ? "Full" : "完整" : canvasDetailStage === "medium" ? locale === "en" ? "Medium" : "中等" : locale === "en" ? "Compact" : "紧凑"}</small></header>
        <div className="canvas-detail-control">
          <strong>{locale === "en" ? "Base cards" : "基础卡片"}</strong>
          <div className="settings-segmented" role="radiogroup" aria-label={locale === "en" ? "Canvas base cards" : "画布基础卡片"}>
            {(["auto", "full", "medium", "minimal"] as CanvasDetailPreference[]).map((preference) => <button
              type="button"
              role="radio"
              aria-checked={canvasDetailPreference === preference}
              className={canvasDetailPreference === preference ? "active" : ""}
              onClick={() => onCanvasDetailPreferenceChange(preference)}
              key={preference}
            >{preference === "auto" ? locale === "en" ? "Auto" : "自动" : preference === "full" ? locale === "en" ? "Full" : "完整" : preference === "medium" ? locale === "en" ? "Medium" : "中等" : locale === "en" ? "One line" : "一行"}</button>)}
          </div>
          <small>{locale === "en"
            ? "Auto is recommended. Fixed levels stay exact except for the uniform Full + All cards emergency guard above 480 visible nodes."
            : `推荐自动档；固定档通常保持原样，仅“完整 + 全部卡片”超过 ${CANVAS_FULL_ALL_MEDIUM_SAFETY_VISIBLE} 个视口节点时启用统一安全级别。`}</small>
        </div>
        <div className="canvas-detail-control">
          <strong>{locale === "en" ? "Overlapping buildings" : "重叠建筑显示"}</strong>
          <div className="settings-segmented" role="radiogroup" aria-label={locale === "en" ? "Overlapping building presentation" : "重叠建筑显示方式"}>
            {(["marker", "representative", "all"] as CanvasOverlapPreference[]).map((preference) => <button
              type="button"
              role="radio"
              aria-checked={canvasOverlapPreference === preference}
              className={canvasOverlapPreference === preference ? "active" : ""}
              onClick={() => onCanvasOverlapPreferenceChange(preference)}
              key={preference}
            >{preference === "marker" ? locale === "en" ? "Count marker" : "数量标记" : preference === "representative" ? locale === "en" ? "Lead card" : "代表卡片" : locale === "en" ? "All cards" : "全部卡片"}</button>)}
          </div>
          <small>{canvasOverlapPreference === "marker"
            ? locale === "en" ? "Recommended: one always-visible “Stack N” marker; members remain independent and selectable." : "推荐：每组始终显示一个“叠放 N”标记；成员仍是独立实体，可点击展开代表建筑。"
            : canvasOverlapPreference === "representative"
              ? locale === "en" ? "Shows one normal card with an explicit stack count." : "显示一张普通代表卡，并明确标注组内独立实体数量。"
              : locale === "en" ? "Keeps every card in the render tree; identical coordinates can still cover one another." : "所有卡片都保留在渲染树中；完全相同坐标仍可能互相覆盖。"}</small>
        </div>
        <div className="canvas-detail-control">
          <strong>{locale === "en" ? "Interaction expansion" : "交互展开"}</strong>
          <div className="settings-segmented" role="radiogroup" aria-label={locale === "en" ? "Interaction card expansion" : "交互卡片展开方式"}>
            {(["selected", "hover", "base"] as CanvasInteractionDetailPreference[]).map((preference) => <button
              type="button"
              role="radio"
              aria-checked={canvasInteractionDetailPreference === preference}
              className={canvasInteractionDetailPreference === preference ? "active" : ""}
              onClick={() => onCanvasInteractionDetailPreferenceChange(preference)}
              key={preference}
            >{preference === "selected" ? locale === "en" ? "Selected only" : "仅选中" : preference === "hover" ? locale === "en" ? "Hover too" : "悬停也展开" : locale === "en" ? "Keep base" : "保持基础"}</button>)}
          </div>
          <small>{locale === "en" ? "Dragging, mining and connection source/targets stay expanded when required for safe interaction." : "拖动、采矿及连线源/目标在安全交互需要时仍会展开，不受此选项关闭。"}</small>
        </div>
        <dl className="canvas-detail-diagnostics" aria-label={locale === "en" ? "Canvas detail diagnostics" : "画布细节诊断"}>
          <div><dt>{locale === "en" ? "Visible nodes" : "视口可见"}</dt><dd>{canvasVisibleNodeCount.toLocaleString(locale)}</dd></div>
          <div><dt>{locale === "en" ? "Current stage" : "当前阶段"}</dt><dd>{canvasDetailStage}</dd></div>
          <div><dt>{locale === "en" ? "Planet overlap" : "活动行星重叠"}</dt><dd>{locale === "en" ? `${canvasStackGroupCount} groups / ${canvasStackHiddenCount} hidden` : `${canvasStackGroupCount} 组 / ${canvasStackHiddenCount} 隐藏`}</dd></div>
        </dl>
        <p className="settings-help">{locale === "en"
          ? "Auto uses viewport-visible logical nodes with hysteresis. These three preferences are device-only and never enter local saves, cloud saves or deterministic simulation."
          : "自动档按视口内原始逻辑节点数并带迟滞切换。以上三项仅保存在本机，不进入本地存档、云存档或确定性模拟。"}</p>
        {canvasDetailPreference === "full" && canvasOverlapPreference === "all" && canvasDetailStage !== "full" ? <p className="settings-warning" role="status">{locale === "en"
          ? `Dense safety is active: ${canvasVisibleNodeCount.toLocaleString(locale)} visible cards use one uniform ${canvasDetailStage} base. Selection and hover expansion still use Full.`
          : `密集保护已启用：当前 ${canvasVisibleNodeCount.toLocaleString(locale)} 个视口节点统一使用${canvasDetailStage === "medium" ? "中等" : "一行"}基础卡；选中和悬停展开仍使用完整卡片。`}</p> : null}
        {canvasDetailPreference === "full" ? <p className="settings-warning" role="alert">{locale === "en"
          ? "Warning: Full detail keeps ordinary cards and live progress eligible for heavier rendering. Dense factories can stutter."
          : "警告：完整档会让普通节点保留重卡片与实时进度资格，密集工厂可能卡顿。"}</p> : null}
        {canvasOverlapPreference === "all" ? <p className="settings-warning" role="alert">{locale === "en"
          ? "All cards can be expensive for large exact stacks. The explicit stack badge remains available for cycling covered members."
          : "全部卡片对大型精确重叠组开销很高；画面仍保留明确堆叠徽标，供循环选择被覆盖成员。"}</p> : null}
      </section>
      <section className="settings-group settings-toggle-list settings-endgame-extreme" data-settings-category="performance">
        <ToggleSetting
          checked={endgameExtremeMode}
          label={locale === "en" ? "Endgame Extreme Mode" : "终局优化·极限模式"}
          value={endgameExtremeMode
            ? locale === "en" ? "Reduced visuals; simulation and saves unchanged" : "视觉降级，模拟与存档结果不变"
            : locale === "en" ? "Off" : "关闭"}
          icon={<Cpu size={16} />}
          onChange={onEndgameExtremeModeChange}
        />
        <p className="settings-help">{locale === "en"
          ? "Device-only setting; reduces belt animation, decoration, and routine readings for large factories or long idle runs."
          : "只保存在当前设备；开启后线路动画、装饰和普通读数刷新会减少，适合大型工厂或长时间挂机。"}</p>
        <ToggleSetting
          checked={connectExpandAll}
          label={locale === "en" ? "Expand every building while connecting" : "连线时展开全星球建筑"}
          value={connectExpandAll
            ? locale === "en" ? "All buildings on the active planet use full cards" : "活动行星全部使用完整建筑卡片"
            : locale === "en" ? "Viewport and interaction targets only" : "仅视口与当前交互目标"}
          icon={<MousePointer2 size={16} />}
          onChange={onConnectExpandAllChange}
        />
        {connectExpandAll ? <p className="settings-warning" role="alert">{locale === "en"
          ? "Warning: very large factories may pause or stutter while connecting. This device-only preference affects only the active planet and never enters saves or cloud sync."
          : "警告：超大工厂连线时可能短暂停顿或卡顿。此偏好只保存在当前设备、仅影响活动行星，不会写入存档或云同步。"}</p> : null}
        <ToggleSetting
          checked={fullRealtimeSimulation}
          label={locale === "en" ? "Full realtime refresh" : "完整实时刷新"}
          value={fullRealtimeSimulation
            ? locale === "en" ? "Live history and Dyson planning payloads" : "实时同步完整历史与戴森规划"
            : locale === "en" ? "Compact active-planet projection" : "仅同步活动行星紧凑投影"}
          icon={<Activity size={16} />}
          onChange={onFullRealtimeSimulationChange}
        />
        <p className={fullRealtimeSimulation ? "settings-warning" : "settings-help"}>{locale === "en"
          ? "Device-only setting. Every simulation tick includes complete production history and Dyson plans; very large saves use substantially more memory and may stutter. Entity telemetry remains active-planet scoped. Off by default."
          : "只保存在当前设备；每个模拟切片都会同步完整生产历史与戴森规划，超大存档会明显增加内存与卡顿；建筑遥测仍只同步活动行星。默认关闭。"}</p>
        <ToggleSetting
          checked={factoryAlertsEnabled}
          label={locale === "en" ? "Factory runtime alerts" : "工厂运行警报"}
          value={factoryAlertsEnabled
            ? locale === "en" ? "Scan factory status in the simulation Worker" : "在模拟 Worker 中扫描全星区设备状态"
            : locale === "en" ? "Off; no alert scan, badge, or list" : "关闭；不扫描、不显示红点与警报列表"}
          icon={<Bell size={16} />}
          onChange={onFactoryAlertsEnabledChange}
        />
        <p className="settings-help">{locale === "en"
          ? "Device-only. Turning this off can improve resume and long-idle responsiveness for very large factories without changing simulation or save data."
          : "仅保存在当前设备。超大工厂关闭后可改善继续模拟与长时间挂机的响应；不会改变模拟结果或存档数据。"}</p>
        <div className="canvas-performance-feature-list" aria-label={canvasPerformanceCopy.ariaLabel}>
          {canvasPerformanceCopy.items.map(([id, label, scope]) => <ToggleSetting
            checked={canvasPerformanceFeatures[id]}
            label={label}
            value={scope}
            icon={<Gauge size={15} />}
            onChange={(enabled) => onCanvasPerformanceFeatureChange(id, enabled)}
            key={id}
          />)}
        </div>
        <p className="settings-help">{canvasPerformanceCopy.help}</p>
      </section>
      <section className="settings-group settings-toggle-list" data-settings-category="performance interaction statistics">
        <ToggleSetting checked={settings.performanceMode} label="性能模式" value={settings.performanceMode ? "精简粒子、阴影与线路动画" : "完整视觉特效"} icon={<Cpu size={16} />} onChange={(performanceMode) => onChange({ performanceMode })} />
        <ToggleSetting checked={settings.reducedMotion} label="减少动态效果" value={settings.reducedMotion ? "动态效果关闭" : "动态效果开启"} icon={<Gauge size={16} />} onChange={(reducedMotion) => onChange({ reducedMotion })} />
        <ToggleSetting checked={settings.soundEnabled} label="操作音效" value={settings.soundEnabled ? "声音开启" : "声音关闭"} icon={settings.soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />} onChange={(soundEnabled) => onChange({ soundEnabled })} />
        <ToggleSetting checked={settings.allowDoubleClickZoom} label="允许双击缩放" value={settings.allowDoubleClickZoom ? "双击聚焦画布" : "连续点击不缩放"} icon={<MousePointer2 size={16} />} onChange={(allowDoubleClickZoom) => onChange({ allowDoubleClickZoom })} />
        <ToggleSetting checked={settings.autoShortageNavigation} label="资源不足自动跳转" value={settings.autoShortageNavigation ? "缺料时打开对应配方" : "缺料只提示，主动点击仍可跳转"} icon={<MapPin size={16} />} onChange={(autoShortageNavigation) => onChange({ autoShortageNavigation })} />
        <ToggleSetting checked={lineFindMode} label="寻线模式默认开启" value={lineFindMode ? "选中建筑后追踪上下游" : "保持普通画布显示"} icon={<Route size={16} />} onChange={onLineFindModeChange} />
        <ToggleSetting checked={showItemHover} label="显示物品悬浮信息" value={showItemHover ? "悬浮或聚焦时显示详情" : "不显示完整悬浮详情卡"} icon={<MousePointer2 size={16} />} onChange={onItemHoverChange} />
        <ToggleSetting checked={showRunLog} label="显示运行记录" value={showRunLog ? "显示运行反馈浮条" : "仅保留错误、成就和诊断"} icon={<Activity size={16} />} onChange={onRunLogChange} />
      </section>
      <section className="settings-group" data-settings-category="storage">
        <header><Database size={14} /><span>{locale === "en" ? "Tab and save authority" : "标签页与存档写入权"}</span><small>{localSaveWriterStatus.role === "primary" ? (locale === "en" ? "This tab is authoritative" : "当前页负责保存") : localSaveWriterStatus.role === "conflict" ? (locale === "en" ? "Save conflict requires resolution" : "存在存档冲突") : (locale === "en" ? "This tab is read-only" : "当前页为只读")}</small></header>
        <p className={localSaveWriterStatus.role === "primary" ? "settings-help" : "settings-warning"}>{localSaveWriterStatus.reason}</p>
        <button type="button" disabled={localSaveTakeoverBusy || localSaveWriterStatus.role !== "secondary"} onClick={() => {
          void (async () => {
            const confirmed = await gameDialog.confirm(locale === "en"
              ? "Force this tab to become authoritative? The other tab will become read-only. This page will be saved and verified first; its current progress wins, while the previous persisted save remains as a backup. Any uncommitted pure-idle time in the other tab will not be awarded."
              : "确认强制接管当前标签页？另一个标签页会立即转为只读。本页会先保存并回读校验，以本页当前进度为准；接管前的主存档仍保留为备份。另一个标签页尚未提交的纯挂机时间不会结算。", {
              danger: true,
              title: locale === "en" ? "Force current tab takeover" : "强制接管当前标签页",
              confirmLabel: locale === "en" ? "Take over this tab" : "确认接管本页",
            });
            if (!confirmed) return;
            setLocalSaveTakeoverBusy(true);
            setLocalSaveTakeoverMessage(locale === "en" ? "Taking over and verifying the save…" : "正在接管并校验存档…");
            try {
              const result = await requestCurrentTabTakeover();
              setLocalSaveTakeoverMessage(result.message);
              if (result.ok && result.reload) window.setTimeout(() => window.location.reload(), 300);
            } catch (error) {
              setLocalSaveTakeoverMessage(error instanceof Error ? error.message : (locale === "en" ? "Takeover failed without overwriting either save." : "接管失败，双方存档均未被覆盖。"));
            } finally {
              setLocalSaveTakeoverBusy(false);
            }
          })();
        }}><RefreshCw size={14} />{localSaveWriterStatus.role === "primary" ? (locale === "en" ? "This tab is already authoritative" : "本页已负责保存") : localSaveTakeoverBusy ? (locale === "en" ? "Taking over…" : "正在接管…") : (locale === "en" ? "Force takeover on this tab" : "强制接管当前标签页")}</button>
        {localSaveTakeoverMessage ? <p className="settings-help" role="status">{localSaveTakeoverMessage}</p> : null}
        <p className="settings-help">{locale === "en" ? "A takeover advances the cross-tab fencing token. The former tab cannot overwrite this save even if it remains open." : "接管会推进跨标签页防覆盖令牌；原标签页即使仍保持打开，也不能再覆盖本页存档。"}</p>
      </section>
      <section className="settings-group" data-settings-category="storage">
        <header><Clock3 size={14} /><span>自动保存间隔</span><small>{locale === "en" ? `configured ${formatAutosaveInterval(largeSaveAutosavePolicy.configuredIntervalSeconds)} · effective ${formatAutosaveInterval(largeSaveAutosavePolicy.effectiveIntervalSeconds)}` : `设置 ${formatAutosaveInterval(largeSaveAutosavePolicy.configuredIntervalSeconds)} · 实际 ${formatAutosaveInterval(largeSaveAutosavePolicy.effectiveIntervalSeconds)}`}</small></header>
        <div className="settings-segmented" aria-label="自动保存间隔">
          {([30, 60, 120, 600, 1800, 0] as AutosaveIntervalSeconds[]).map((seconds) => (
            <button className={settings.autosaveIntervalSeconds === seconds ? "active" : ""} type="button" key={seconds} onClick={() => onChange({ autosaveIntervalSeconds: seconds })}>{seconds === 0 ? "关闭" : seconds >= 600 ? `${seconds / 60} 分钟` : `${seconds} 秒`}</button>
          ))}
        </div>
        {settings.autosaveIntervalSeconds === 0 ? <p className="settings-warning">关闭后，刷新、崩溃或异常退出可能丢失未保存进度；手动保存和云同步保持独立。</p> : null}
        <ToggleSetting
          checked={largeSaveAutosaveProtection}
          label={locale === "en" ? "Large-save autosave protection (recommended)" : "超大存档自动保存保护（推荐）"}
          value={largeSaveAutosaveProtection
            ? locale === "en" ? `Device-only; ${autosaveSizeLabel}${largeSaveAutosavePolicy.throttled ? " · minimum 10 min" : ""}` : `仅本机；${autosaveSizeLabel}${largeSaveAutosavePolicy.throttled ? " · 最短 10 分钟" : ""}`
            : locale === "en" ? "Off; use the configured interval" : "关闭；按存档设置频率执行"}
          icon={<ShieldCheck size={16} />}
          onChange={onLargeSaveAutosaveProtectionChange}
        />
        <p className={largeSaveAutosavePolicy.largeSave && !largeSaveAutosaveProtection ? "settings-warning" : "settings-help"} role={largeSaveAutosavePolicy.largeSave && !largeSaveAutosaveProtection ? "alert" : undefined}>{largeSaveAutosavePolicy.largeSave && !largeSaveAutosaveProtection
          ? locale === "en" ? "Protection is off; frequent writes on this large save may cause stutter. Manual save, return-to-menu and export are unchanged." : "保护已关闭；当前超大存档将按配置频率写入，可能出现卡顿。手动保存、返回主页和导出不受影响。"
          : locale === "en" ? "Device-only. At or above 24 MiB, background autosave uses at least 10 minutes; manual save, return-to-menu and export are unchanged." : "仅保存在当前设备。存档达到 24 MiB 后，后台自动保存最短间隔为 10 分钟；手动保存、返回主页和导出不受影响。"}</p>
        <ToggleSetting
          checked={allowEditsDuringSave}
          label={locale === "en" ? "Allow editing while saving (experimental)" : "保存期间允许继续操作（实验性）"}
          value={allowEditsDuringSave
            ? locale === "en" ? "Device-only; saves no longer reject or undo your edits; recovery head catches up on the next save." : "仅本机；保存不再拒绝或撤销你的操作，recovery 会在下次保存时追赶。"
            : locale === "en" ? "Off; edits are rejected while a save is in progress (fail-safe default)." : "关闭；保存进行中的操作会被拒绝（默认保护模式）。"}
          icon={<ShieldCheck size={16} />}
          onChange={onAllowEditsDuringSaveChange}
        />
        <p className="settings-help">{locale === "en"
          ? "When enabled, edits made during a save are kept in the durable queue. If a save fails, your current progress is preserved for export instead of being rolled back."
          : "开启后，保存期间的操作会保留在 durable 队列，不会因为保存而被拒绝或回滚；保存失败时当前进度也保留，可立即导出。"}</p>
      </section>
      <section className="settings-group" data-settings-category="storage">
        <header><MapPin size={14} /><span>星区与资源</span><small>种子 #{game.galaxy.seed}</small></header>
        <div className="settings-segmented" aria-label="资源模式">
          <button className={settings.resourceMode === "finite" ? "active" : ""} type="button" onClick={async () => {
            if (settings.resourceMode === "finite") return;
            const confirmed = await gameDialog.confirm(locale === "en"
              ? "Switch to finite resources? Existing miners, belts, and buffers will be preserved, and veins will resume consuming their remaining reserves."
              : "确认切换为有限矿脉？现有矿机、线路与缓存会保留，矿脉将继续消耗剩余储量。", { confirmLabel: locale === "en" ? "Switch" : "确认切换" });
            if (!confirmed) return;
            onChange({ resourceMode: "finite" });
          }}>有限矿脉</button>
          <button className={settings.resourceMode === "infinite" ? "active" : ""} type="button" onClick={async () => {
            if (settings.resourceMode === "infinite") return;
            const confirmed = await gameDialog.confirm(locale === "en"
              ? "Switch to infinite resources? Existing miners, belts, and buffers will be preserved, and depleted veins will resume production."
              : "确认切换为无限矿脉？现有矿机、线路与缓存会保留，已枯竭矿脉将恢复生产。", { confirmLabel: locale === "en" ? "Switch" : "确认切换" });
            if (!confirmed) return;
            onChange({ resourceMode: "infinite" });
          }}>无限矿脉</button>
        </div>
      </section>
      <section className="settings-group settings-difficulty-group" data-settings-category="other">
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
      <section className="settings-group settings-diagnostics" data-settings-category="statistics">
        <header><ShieldCheck size={14} /><span>模拟诊断</span><small>确定性、2/8/24/72 小时挂机与数值平衡</small></header>
        <button type="button" onClick={onRunBenchmark} title="同时执行 2/8/24/72 小时挂机检查"><Gauge size={14} />运行 60 秒基准</button>
        {report ? <div className={`automatic-performance-report${report.benchmark.deterministic && report.idleStress.completed && report.idleStress.integrityPassed ? " automatic-performance-report--passed" : " automatic-performance-report--warning"}`}>
          <header><span>自动性能报告</span><small>{new Date(report.generatedAt).toLocaleTimeString("zh-CN")}</small></header>
          <div className="automatic-performance-metrics"><span>确定性 <strong>{report.benchmark.deterministic ? "通过" : "失败"}</strong></span><span>60 秒 <strong>{report.benchmark.durationMs} ms</strong></span><span>压力 <strong>{report.idleStress.simulatedHours} h / {report.idleStress.durationMs} ms</strong></span><span>整数校验 <strong>{report.idleStress.integrityPassed ? "通过" : "异常"}</strong></span></div>
          <div className="automatic-balance-metrics"><span>设备 {Math.round(report.balance.machineEfficiency * 100)}%</span><span>物流 {Math.round(report.balance.logisticsEfficiency * 100)}%</span><span>供电 {Math.round(report.balance.powerEfficiency * 100)}%</span><span>电力余量 <PowerValue valueKw={report.balance.powerMarginKw} /></span></div>
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
      <NativeUpdateCard showWebFallback />
      <section className="settings-group settings-tutorial-entry" data-settings-category="other">
        <header><GraduationCap size={14} /><span>零基础教程</span><small>桌面与手机通用</small></header>
        <button type="button" onClick={onOpenTutorial} aria-label="打开新手教程"><GraduationCap size={15} /><span><strong>打开完整自然语言教程</strong><small>从采集、传送带到物流、戴森和存档</small></span><ChevronRight size={15} /></button>
      </section>
      <section className="settings-group settings-release-notes" data-settings-category="other">
        <header><History size={14} /><span>版本更新记录</span><small>{currentReleaseNotes.date}</small></header>
        <button type="button" onClick={onOpenReleaseNotes} aria-label="查看版本更新记录"><History size={15} /><span><strong>{currentReleaseNotes.title}</strong><small>{currentReleaseNotes.items.length} 项体验更新</small></span></button>
      </section>
      <section className="settings-group settings-community" data-settings-category="other">
        <header><MessageSquare size={14} /><span>QQ 交流群</span><small>意见、建议与问题反馈</small></header>
        <div><span>群号</span><strong>1076757280</strong></div>
      </section>
    </div>
  );
}

function formatDiagnosticBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function PerformancePanel({ game, snapshot, onStart, onStop, onClear, onExport }: {
  game: GameState;
  snapshot: PerformanceMonitorSnapshot;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onExport: () => void;
}) {
  const latest = snapshot.samples.at(-1) ?? null;
  const logisticsProfile = latest?.phases;
  const peerHitRate = logisticsProfile && logisticsProfile.peerMatchCalls > 0
    ? logisticsProfile.peerMatchCacheHits / logisticsProfile.peerMatchCalls
    : 0;
  const routeCalls = (logisticsProfile?.routeEconomicsCalls ?? 0) + (logisticsProfile?.routeEconomicsCacheHits ?? 0);
  const routeHitRate = routeCalls > 0 ? (logisticsProfile?.routeEconomicsCacheHits ?? 0) / routeCalls : 0;
  const peaks = getPerformancePeaks(snapshot.samples);
  const phases = getPerformancePhaseShares(latest);
  const planetRows = Object.entries(game.planetTrays).map(([planetId]) => ({
    planetId,
    entities: game.entities.filter((entity) => entity.planetId === planetId).length,
    belts: game.belts.filter((belt) => belt.planetId === planetId).length,
    routes: game.entities.filter((entity) => entity.planetId === planetId).reduce((sum, entity) => sum + (entity.stationRoutes?.length ?? 0), 0),
  })).filter((row) => row.entities + row.belts + row.routes > 0).sort((left, right) => right.entities + right.belts - left.entities - left.belts);
  const stallPeaks = [...snapshot.samples].sort((left, right) => right.peakFrameMs - left.peakFrameMs).slice(0, 5);
  return <div className="operations-panel performance-monitor-panel">
    <header className="operations-section-header performance-monitor-header"><div><span>按需阶段计时</span><strong>性能监控与卡顿诊断</strong></div><span className={`settings-state${snapshot.active ? " positive" : ""}`}><Activity size={14} />{snapshot.active ? "正在采样" : "监控已关闭"}</span></header>
    <div className="performance-monitor-actions">
      {snapshot.active ? <button type="button" onClick={onStop}><Power size={15} />停止采样</button> : <button className="primary" type="button" onClick={onStart}><Activity size={15} />开始采样</button>}
      <button type="button" disabled={snapshot.samples.length === 0} onClick={onClear}><Trash2 size={15} />清空记录</button>
      <button type="button" disabled={snapshot.samples.length === 0} onClick={onExport}><Download size={15} />导出匿名报告</button>
    </div>
    <p className="performance-monitor-note">浏览器不提供各玩法的真实 CPU 百分比；下方占比来自 Worker 内各模拟阶段的实际执行耗时。监控关闭时不启用阶段计时。</p>
    {!latest ? <div className="operations-empty performance-monitor-empty"><Gauge size={28} /><strong>{snapshot.active ? "正在建立首个 1 秒样本" : "尚未采样"}</strong><span>开启后保留最近 60 秒，不写入游戏状态或云存档。</span></div> : <>
      <section className="performance-kpi-grid" aria-label="实时性能摘要">
        <article><span>FPS</span><strong>{latest.fps.toFixed(1)}</strong><small>平均帧 {latest.averageFrameMs.toFixed(1)} ms</small></article>
        <article><span>帧耗时 P50 / P95</span><strong>{latest.frameP50Ms.toFixed(1)} / {latest.frameP95Ms.toFixed(1)} ms</strong><small>最大 {latest.peakFrameMs.toFixed(1)} ms</small></article>
        <article><span>长帧分桶</span><strong>{latest.longFrames.over50Ms} / {latest.longFrames.over100Ms}</strong><small>&gt;50 / &gt;100 ms · &gt;250 {latest.longFrames.over250Ms} · &gt;500 {latest.longFrames.over500Ms}</small></article>
        <article><span>模拟 Worker</span><strong>{latest.workerDurationMs.toFixed(1)} ms</strong><small>往返 {latest.workerLatencyMs.toFixed(1)} ms</small></article>
        <article><span>Worker 状态传输</span><strong>{formatDiagnosticBytes(latest.stateTransferBytes)}</strong><small>请求 {formatDiagnosticBytes(latest.workerRequestBytes)} · 响应 {formatDiagnosticBytes(latest.workerResponseBytes)}</small></article>
        <article><span>任务积压</span><strong>{latest.pendingTaskMs.toFixed(0)} ms</strong><small>待处理模拟时间</small></article>
        <article><span>JS 堆内存</span><strong>{formatDiagnosticBytes(latest.memory.usedBytes)}</strong><small>可用 {formatDiagnosticBytes(latest.memory.availableBytes)}</small></article>
        <article><span>画布快照</span><strong>{latest.canvas.snapshotMs.toFixed(2)} ms</strong><small>节点 {latest.canvas.nodeDerivationMs.toFixed(2)} · 线路 {latest.canvas.edgeDerivationMs.toFixed(2)} ms</small></article>
        <article><span>React Flow 对象</span><strong>{latest.canvas.reactFlowNodeCount} 节点 / {latest.canvas.reactFlowEdgeCount} 线路</strong><small>Canvas 批量 {latest.canvas.canvasLineSegments} 条</small></article>
        <article><span>实际 DOM</span><strong>{latest.canvas.domNodeCount} 节点 / {latest.canvas.domEdgeCount} 线路</strong><small>画布元素 {latest.canvas.domElementCount.toLocaleString("zh-CN")}</small></article>
        <article><span>画布发布</span><strong>{latest.canvas.refreshIntervalMs} ms</strong><small>{latest.canvas.endgameExtremeMode ? "终局·极限模式" : "普通模式"} · LOD {latest.canvas.lod}</small></article>
        <article><span>状态 / 主存档</span><strong>{formatDiagnosticBytes(latest.stateBytes)}</strong><small>{formatDiagnosticBytes(latest.saveBytes)}</small></article>
        <article><span>最近保存</span><strong>{latest.autosaveMs.toFixed(1)} ms</strong><small>包括写入后校验</small></article>
        {latest.saveStorage ? <article><span>本地存档</span><strong>{latest.saveStorage.slotCount} 槽 / {latest.saveStorage.snapshotCount} 快照</strong><small>{formatDiagnosticBytes(latest.saveStorage.totalBytes)} · 统计 {latest.saveStorage.scanMs.toFixed(1)} ms</small></article> : null}
        <article><span>最近离线结算</span><strong>{snapshot.lastOfflineSimulationMs > 0 ? `${snapshot.lastOfflineSimulationMs.toFixed(0)} ms` : "--"}</strong><small>本次页面会话</small></article>
      </section>
      {latest.saveStages ? <section className="performance-scale-section performance-save-stages"><header><HardDrive size={15} /><span><strong>存档阶段耗时</strong><small>最近一次已完成保存</small></span></header><div><article><strong>{latest.saveStages.serializeMs.toFixed(1)} ms</strong><span>序列化与校验</span></article><article><strong>{latest.saveStages.snapshotScanMs.toFixed(1)} ms</strong><span>快照元数据</span></article><article><strong>{latest.saveStages.capacityMs.toFixed(1)} ms</strong><span>容量检查</span></article><article><strong>{latest.saveStages.primaryWriteMs.toFixed(1)} ms</strong><span>主档写入/读回</span></article><article><strong>{latest.saveStages.backupMs.toFixed(1)} ms</strong><span>上一版备份</span></article><article><strong>{latest.saveStages.automaticSnapshotMs.toFixed(1)} ms</strong><span>自动快照</span></article></div></section> : null}
      <section className="performance-phase-section"><header><Cpu size={15} /><span><strong>模拟阶段耗时归因</strong><small>最近一个 Worker 批次</small></span></header>{phases.length ? <div className="performance-phase-list">{phases.map((phase) => <div key={phase.id}><span>{phase.label}</span><i><b style={{ width: `${Math.max(1, phase.share * 100)}%` }} /></i><strong>{phase.durationMs.toFixed(2)} ms</strong><em>{Math.round(phase.share * 100)}%</em></div>)}</div> : <p>等待下一次带阶段计时的 Worker 结果。</p>}</section>
      {logisticsProfile ? <section className="performance-scale-section performance-logistics-cache"><header><Route size={15} /><span><strong>物流匹配与缓存</strong><small>最近一个 Worker 批次</small></span></header><div><article><strong>{logisticsProfile.peerCandidateChecks.toLocaleString("zh-CN")}</strong><span>伙伴候选检查</span><span>匹配调用 {logisticsProfile.peerMatchCalls}</span></article><article><strong>{Math.round(peerHitRate * 100)}%</strong><span>伙伴缓存命中</span><span>{logisticsProfile.peerMatchCacheHits} 次复用</span></article><article><strong>{logisticsProfile.dispatchSlotChecks.toLocaleString("zh-CN")}</strong><span>派遣槽检查</span><span>建立航线 {logisticsProfile.routesCreated}</span></article><article><strong>{logisticsProfile.routePathPlans.toLocaleString("zh-CN")}</strong><span>实际路径规划</span><span>路径命中 {logisticsProfile.routePathCacheHits}</span></article><article><strong>{Math.round(routeHitRate * 100)}%</strong><span>路线经济缓存</span><span>Worker 状态复用 {logisticsProfile.persistentRuntimeHits}</span></article></div></section> : null}
      <section className="performance-scale-section"><header><HardDrive size={15} /><span><strong>行星规模与在途物流</strong><small>当前真实状态</small></span></header><div>{planetRows.map((row) => <article key={row.planetId}><strong>{getPlanetDisplayName(game, row.planetId as GameState["activePlanetId"])}</strong><span>实体 {row.entities}</span><span>线路 {row.belts}</span><span>在途 {row.routes}</span></article>)}</div></section>
      <section className="performance-peaks-section"><header><AlertTriangle size={15} /><span><strong>最近 60 秒卡顿峰值</strong><small>主线程 {peaks.peakFrameMs.toFixed(1)} ms · Worker {peaks.peakWorkerMs.toFixed(1)} ms · &gt;100 {peaks.over100Ms} · &gt;250 {peaks.over250Ms} · &gt;500 {peaks.over500Ms}</small></span></header>{stallPeaks.map((sample) => <div key={sample.recordedAt}><time>{new Date(sample.recordedAt).toLocaleTimeString("zh-CN")}</time><span>帧峰值 {sample.peakFrameMs.toFixed(1)} ms</span><span>Worker {sample.workerDurationMs.toFixed(1)} ms</span><span>积压 {sample.pendingTaskMs.toFixed(0)} ms</span></div>)}</section>
    </>}
  </div>;
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
  onConfirmImportRescue,
  importRescueArmed,
  onCancelImport,
  onSaveSlot,
  onLoadSlot,
  onDeleteSlot,
  onCreateSnapshot,
  onAddSecondUnipolarVein,
  unipolarExpansionBusy,
  onLoadSnapshot,
  onDeleteSnapshot,
  onDeleteSnapshots,
  onValidateMod,
  onExportModTemplate,
}: Pick<OperationsWorkspaceProps,
  "game" | "slots" | "snapshots" | "importPreview" | "modValidation" | "onManualSave" | "onExport" | "onImport" | "onConfirmImport" | "onConfirmImportRescue" | "importRescueArmed" | "onCancelImport" | "onSaveSlot" | "onLoadSlot" | "onDeleteSlot" | "onCreateSnapshot" | "onAddSecondUnipolarVein" | "unipolarExpansionBusy" | "onLoadSnapshot" | "onDeleteSnapshot" | "onDeleteSnapshots" | "onValidateMod" | "onExportModTemplate">) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modInputRef = useRef<HTMLInputElement>(null);
  const [deleteRequest, setDeleteRequest] = useState<(SaveDeleteTarget & ({ kind: "slot"; slotId: SaveSlotId } | { kind: "snapshot"; snapshotId: string } | { kind: "snapshots"; snapshotIds: string[] } | { kind: "managed-storage"; keys: string[] })) | null>(null);
  const [selectedSnapshotIds, setSelectedSnapshotIds] = useState<string[]>([]);
  const [selectedStorageKeys, setSelectedStorageKeys] = useState<string[]>([]);
  const [storageEstimate, setStorageEstimate] = useState<LocalSaveStorageEstimate | null>(null);
  const [persistenceRequestPending, setPersistenceRequestPending] = useState(false);
  const summaryBySlot = new Map(slots.map((slot) => [slot.slotId, slot]));
  const automaticSnapshotCount = snapshots.filter((snapshot) => snapshot.reason === "自动快照").length;
  const manualSnapshotCount = snapshots.length - automaticSnapshotCount;
  const protectedSnapshotIds = new Set((storageEstimate?.entries ?? []).flatMap((entry) => {
    if (!entry.protected || !entry.key.includes(".snapshot.")) return [];
    const prefix = entry.mode === "speedrun" ? "dsp-idle-network.save.v1.snapshot.speedrun." : "dsp-idle-network.save.v1.snapshot.";
    return entry.key.startsWith(prefix) ? [entry.key.slice(prefix.length)] : [];
  }));
  const unipolarCount = game.entities.filter((entity) => entity.kind === "vein" && entity.resourceId === "unipolar_magnet").length;
  const unipolarEligible = game.mode !== "speedrun" && game.speedrun?.enabled !== true && unipolarCount === 1 && game.paused;
  const unipolarStatus = game.mode === "speedrun" || game.speedrun?.enabled === true
    ? "速通存档禁止扩容"
    : unipolarCount >= 2 ? `当前 ${unipolarCount} 个，硬上限 2`
      : !game.paused ? "请先暂停模拟"
        : unipolarCount === 1 ? "符合一次性扩容条件" : `当前 ${unipolarCount} 个，需先通过资源审计`;
  useEffect(() => {
    let active = true;
    const refresh = () => void getLocalSaveStorageEstimate().then((estimate) => { if (active) setStorageEstimate(estimate); });
    refresh();
    const unsubscribe = subscribeLocalSaveStorageStatus(refresh);
    return () => { active = false; unsubscribe(); };
  }, [slots, snapshots]);
  useEffect(() => setSelectedSnapshotIds((current) => current.filter((id) => snapshots.some((snapshot) => snapshot.id === id))), [snapshots]);
  useEffect(() => setSelectedStorageKeys((current) => current.filter((key) => storageEstimate?.entries.some((entry) => entry.key === key) ?? false)), [storageEstimate]);
  const formatBytes = (bytes: number | null) => bytes === null ? "不可用" : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${Math.max(0, Math.round(bytes / 1024))} KiB`;
  const persistenceLabel = storageEstimate?.persistenceStatus === "granted" ? "已受持久保护"
    : storageEstimate?.persistenceStatus === "denied" ? "浏览器未授予"
      : storageEstimate?.persistenceStatus === "unsupported" ? "当前环境不支持"
        : "尚未请求";
  const requestPersistence = async () => {
    setPersistenceRequestPending(true);
    await requestLocalSavePersistentStorage();
    setStorageEstimate(await getLocalSaveStorageEstimate());
    setPersistenceRequestPending(false);
  };
  return (
    <div className="operations-panel operations-saves">
      <header className="operations-section-header">
        <div><span>本地数据</span><strong>存档管理</strong></div>
        <span className="save-runtime"><Clock3 size={13} />运行 {formatRuntime(game.elapsedSeconds)}</span>
      </header>
      <section className="save-primary-actions">
        <button type="button" onClick={onManualSave}><Save size={15} /><span>立即保存</span></button>
        <button type="button" onClick={onCreateSnapshot}><History size={15} /><span>创建快照</span></button>
        <button type="button" onClick={onExport}><Download size={15} /><span>导出压缩存档</span></button>
        <button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={15} /><span>导入存档</span></button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,application/gzip,.json,.json.gz,.gz"
          aria-label="选择要导入的存档文件"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) onImport(await readSaveFileBytes(file));
            event.target.value = "";
          }}
        />
      </section>
      <section className="save-resource-integrity-tool" aria-label="单极磁石矿脉扩容工具">
        <header><div><ShieldCheck size={14} /><strong>单极磁石矿脉扩容</strong></div><small>{unipolarStatus}</small></header>
        <p>仅为恰好拥有 1 个规范矿脉的普通存档新增 1 个矿脉；总数硬上限为 2。操作会先创建恢复快照，不会写入矿物缓存、托盘、累计产量或排行榜。</p>
        <div><span>当前数量 <strong>{unipolarCount}</strong></span><span>目标数量 <strong>2</strong></span><span>模式 <strong>{game.mode === "speedrun" ? "速通" : "普通"}</strong></span></div>
        <button type="button" className="danger" disabled={!unipolarEligible || unipolarExpansionBusy} onClick={onAddSecondUnipolarVein}>
          <MapPin size={14} />{unipolarExpansionBusy ? "正在备份并校验…" : "备份后增加 1 个矿脉"}
        </button>
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
        <footer><button type="button" onClick={onCancelImport}>取消</button>{importPreview.valid ? <button className="primary" type="button" onClick={onConfirmImport}><ShieldCheck size={14} />确认导入</button> : importPreview.repairable ? <button className={importRescueArmed ? "danger" : "primary"} type="button" onClick={onConfirmImportRescue}><ShieldCheck size={14} />{importRescueArmed ? "再次确认并救援" : "救援此存档"}</button> : <button type="button" disabled>无法导入</button>}</footer>
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
        <header><div><History size={14} /><strong>恢复快照</strong><small>自动 {automaticSnapshotCount}/2 · 手动 {manualSnapshotCount}</small></div>{selectedSnapshotIds.length > 0 ? <button className="save-batch-delete" type="button" onClick={() => setDeleteRequest({ kind: "snapshots", snapshotIds: selectedSnapshotIds, label: `${selectedSnapshotIds.length} 份所选快照`, details: "只删除明确勾选的恢复快照；主存档和三个手动槽位不会受影响" })}><Trash2 size={13} />删除所选</button> : <span>可回滚</span>}</header>
        {snapshots.length === 0 ? <p className="save-empty-note">模拟运行后会自动保留最近快照</p> : <div className="save-snapshot-list">
          {snapshots.map((snapshot) => <article className={`save-snapshot-row${snapshot.valid ? "" : " save-snapshot-row--invalid"}${protectedSnapshotIds.has(snapshot.id) ? " save-snapshot-row--protected" : ""}`} key={snapshot.id}>
            <input type="checkbox" checked={selectedSnapshotIds.includes(snapshot.id)} onChange={(event) => setSelectedSnapshotIds((current) => event.target.checked ? [...current, snapshot.id] : current.filter((id) => id !== snapshot.id))} aria-label={`选择快照 ${snapshot.reason}`} />
            <i>{snapshot.valid ? <ShieldCheck size={14} /> : <FileCheck2 size={14} />}</i>
            <div><strong>{snapshot.reason}{protectedSnapshotIds.has(snapshot.id) ? <em>保护</em> : null}</strong><span>{new Date(snapshot.savedAt).toLocaleTimeString("zh-CN")} · {formatRuntime(snapshot.elapsedSeconds)} · 科技 {snapshot.completedTechCount}</span></div>
            <button type="button" disabled={!snapshot.valid} onClick={() => onLoadSnapshot(snapshot.id)} title="回滚到此快照" aria-label={`回滚到快照 ${snapshot.id}`}><RotateCcw size={13} /></button>
            <button type="button" onClick={() => setDeleteRequest({ kind: "snapshot", snapshotId: snapshot.id, label: `快照：${snapshot.reason}`, details: `${new Date(snapshot.savedAt).toLocaleString("zh-CN")} · 运行 ${formatRuntime(snapshot.elapsedSeconds)} · 科技 ${snapshot.completedTechCount}` })} title="删除快照" aria-label={`删除快照 ${snapshot.id}`}><Trash2 size={13} /></button>
          </article>)}
        </div>}
      </section>
      {storageEstimate ? <section className="save-storage-usage" aria-label="本地存储占用">
        <header><div><Database size={14} /><strong>存储占用</strong></div><small>{storageEstimate.backend === "indexeddb" ? "IndexedDB" : storageEstimate.backend === "local-storage" ? "兼容存储" : "临时内存"}</small></header>
        <div className="save-storage-kpis"><span><small>存档数据</small><strong>{formatBytes(storageEstimate.payloadBytes)}</strong></span><span><small>浏览器总占用</small><strong>{formatBytes(storageEstimate.browserUsageBytes)}</strong></span><span><small>可用配额</small><strong>{storageEstimate.browserQuotaBytes === null || storageEstimate.browserUsageBytes === null ? "不可用" : formatBytes(Math.max(0, storageEstimate.browserQuotaBytes - storageEstimate.browserUsageBytes))}</strong></span></div>
        <div className={`save-persistence-state save-persistence-state--${storageEstimate.persistenceStatus}`} role="status">
          <ShieldCheck size={15} />
          <span><strong>浏览器持久存储：{persistenceLabel}</strong><small>{storageEstimate.persistenceStatus === "granted" ? "浏览器会尽量避免在空间回收时移除本地存档。" : "拒绝或不支持不会影响游玩；仍建议定期导出重要存档。"}</small></span>
          {storageEstimate.persistenceStatus !== "granted" && storageEstimate.persistenceRequestSupported ? <button type="button" disabled={persistenceRequestPending} onClick={() => void requestPersistence()}>{persistenceRequestPending ? "请求中" : storageEstimate.persistenceStatus === "denied" ? "重新请求" : "请求保护"}</button> : null}
        </div>
        <div className="save-storage-mode-grid" aria-label="按模式存储占用">
          {storageEstimate.modes.map((usage) => <article key={usage.mode} data-mode={usage.mode}>
            <header><strong>{usage.mode === "speedrun" ? "速通模式" : "普通模式"}</strong><em>{formatBytes(usage.totalBytes)}</em></header>
            <dl>
              <div><dt>主档 / 备份</dt><dd>{formatBytes(usage.primaryBytes + usage.backupBytes)}</dd></div>
              <div><dt>手动槽位</dt><dd>{usage.slotCount} · {formatBytes(usage.slotBytes)}</dd></div>
              <div><dt>自动快照</dt><dd>{usage.automaticSnapshotCount}/2 · {formatBytes(usage.automaticSnapshotBytes)}</dd></div>
              <div><dt>手动快照</dt><dd>{usage.manualSnapshotCount} · {formatBytes(usage.manualSnapshotBytes)}</dd></div>
              <div><dt>保护快照</dt><dd>{usage.protectedCount} · {formatBytes(usage.protectedBytes)}</dd></div>
              <div><dt>导入缓存</dt><dd>{usage.importCacheCount} · {formatBytes(usage.importCacheBytes)}</dd></div>
            </dl>
          </article>)}
        </div>
        {storageEstimate.recoveryPrompt ? <div className="save-storage-recovery" role="alert"><AlertTriangle size={16} /><span><strong>{storageEstimate.recoveryPrompt.preservedChecksummedMain ? "旧主档已保留" : "需要立即恢复"}</strong><small>{storageEstimate.recoveryPrompt.message}</small></span><div><button type="button" onClick={onExport}>立即导出</button><button type="button" onClick={() => { dismissLocalSaveRecoveryPrompt(); setStorageEstimate((current) => current ? { ...current, recoveryPrompt: null } : current); }}>知道了</button></div></div> : null}
        {storageEstimate.warnings.length > 0 ? <div className="save-storage-warnings">{storageEstimate.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} />{warning}</p>)}</div> : null}
        <div className="save-storage-list-header"><span>清理只作用于明确勾选的手动/保护快照或导入缓存，保护项默认不勾选。</span>{selectedStorageKeys.length > 0 ? <button type="button" className="save-batch-delete" onClick={() => setDeleteRequest({ kind: "managed-storage", keys: selectedStorageKeys, label: `${selectedStorageKeys.length} 份本地恢复数据`, details: "只删除当前容量清单中明确勾选的数据；主档、备份、手动槽位和自动快照不会受影响" })}><Trash2 size={13} />删除所选</button> : null}</div>
        <div className="save-storage-entries">{storageEstimate.entries.map((entry) => {
          const selectable = entry.category === "manual-snapshot" || entry.category === "import-cache" || entry.category === "protected" && entry.key.includes(".snapshot.");
          return <div className={entry.protected ? "protected" : ""} key={entry.key}>{selectable ? <input type="checkbox" checked={selectedStorageKeys.includes(entry.key)} onChange={(event) => setSelectedStorageKeys((current) => event.target.checked ? [...current, entry.key] : current.filter((key) => key !== entry.key))} aria-label={`选择清理 ${entry.label}`} /> : <i aria-hidden="true" />}<span><strong>{entry.label}</strong><small>{entry.source}{entry.savedAt > 0 ? ` · ${new Date(entry.savedAt).toLocaleString("zh-CN")}` : ""}</small></span><em>{entry.protected ? "保护" : entry.automatic ? "自动" : "玩家管理"}</em><b>{formatBytes(entry.bytes)}</b></div>;
        })}</div>
      </section> : null}
      <section className="content-pack-section">
        <header><div><FileCheck2 size={14} /><strong>内容包校验</strong></div><small>只读检查，不会修改核心目录</small></header>
        <div className="content-pack-actions"><button type="button" onClick={() => modInputRef.current?.click()}><Upload size={14} />选择内容包 JSON</button><button type="button" onClick={onExportModTemplate}><Download size={14} />导出模板</button></div>
        <input ref={modInputRef} type="file" accept="application/json,.json" aria-label="选择内容包文件" onChange={async (event) => { const file = event.target.files?.[0]; if (file) onValidateMod(await file.text()); event.target.value = ""; }} />
        {modValidation ? <div className={`content-pack-result${modValidation.valid ? " content-pack-result--valid" : " content-pack-result--invalid"}`}><strong>{modValidation.valid ? "内容包校验通过" : "内容包存在问题"}</strong><span>{modValidation.manifest?.name ?? "未识别内容包"} · 物品 {modValidation.counts.items} · 配方 {modValidation.counts.recipes} · 科技 {modValidation.counts.technologies}</span>{modValidation.issues.slice(0, 3).map((issue) => <small key={`${issue.code}-${issue.path}`}>{issue.severity === "error" ? "错误" : "提示"}：{issue.message}</small>)}</div> : null}
      </section>
      <SaveDeleteDialog target={deleteRequest} onCancel={() => setDeleteRequest(null)} onDelete={() => {
        if (!deleteRequest) return;
        if (deleteRequest.kind === "slot") onDeleteSlot(deleteRequest.slotId);
        else if (deleteRequest.kind === "snapshot") onDeleteSnapshot(deleteRequest.snapshotId);
        else if (deleteRequest.kind === "snapshots") { onDeleteSnapshots(deleteRequest.snapshotIds); setSelectedSnapshotIds([]); }
        else { void deleteLocalSaveManagedEntries(deleteRequest.keys).then(() => getLocalSaveStorageEstimate()).then(setStorageEstimate); setSelectedStorageKeys([]); }
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
  const pwaUpdateCopy = pwaUpdateStatusCopy(pwa.updateStatus);
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

  const historicalPlayers = playerDisplayAdjustment(cloudApiBase(true), window.location.href);
  const displayedPlayerTotal = cloudStatus ? cloudStatus.players.total + (historicalPlayers?.count ?? 0) : null;
  const diagnostics = () => collectClientDiagnostics(game, report);
  const submitFeedback = async () => {
    if (!feedback.trim()) return;
    setFeedbackState("sending");
    setFeedbackMessage(null);
    try {
      const id = await sendCloudFeedback(feedbackKind, feedback.trim(), diagnostics());
      clearStableTextDraft("operations-feedback");
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
        <article><Users size={18} /><span><small>累计游玩玩家</small><strong>{displayedPlayerTotal?.toLocaleString("zh-CN") ?? "--"}</strong></span><em title={historicalPlayers?.description}>{historicalPlayers?.label ?? "匿名标识去重"}</em></article>
        <article className="support-player-online"><Radio size={18} /><span><small>当前在线游玩</small><strong>{cloudStatus?.players.online.toLocaleString("zh-CN") ?? "--"}</strong></span><em>{cloudStatus ? `${cloudStatus.players.onlineWindowSeconds} 秒内活跃` : "等待云节点"}</em></article>
        <article><Smartphone size={18} /><span><small>PWA 状态</small><strong>{pwa.installed ? "已安装" : pwa.supported ? "浏览器运行" : "不可用"}</strong></span>{pwa.installAvailable ? <button type="button" onClick={() => void requestPwaInstall()}>安装</button> : null}</article>
        <article data-pwa-update-status={pwa.updateStatus}><RotateCcw size={18} /><span><small>网页版本</small><strong>v{__APP_VERSION__}</strong></span>{pwa.updateStatus === "downloaded-await-restart" && pwa.updateAvailable ? <button className="ready" type="button" onClick={applyPwaUpdate}>重启并更新</button> : <em className={`settings-state settings-state--${pwaUpdateCopy.tone}`} role="status" data-copy-key={pwaUpdateCopy.key}>{pwaUpdateCopy.text}</em>}</article>
      </section>
      <section className="support-diagnostics-export">
        <div><ShieldCheck size={16} /><span><strong>匿名诊断包</strong><small>环境、工厂规模、性能结果和最近错误，不包含密码与完整存档。</small></span></div>
        <button type="button" onClick={() => void downloadDiagnostics(diagnostics())}><Download size={14} />导出 JSON</button>
      </section>
      <section className="support-source-link">
        <Github size={16} />
        <span><strong>源码仓库</strong><small>PolyForm Noncommercial 1.0.0 · 仅限非商业用途</small></span>
        <a href={PROJECT_SOURCE_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} />GitHub</a>
      </section>
      <section className="support-feedback-form">
        <header><MessageSquare size={15} /><span><strong>提交反馈</strong><small>会附带同一份匿名诊断摘要</small></span></header>
        <div className="support-feedback-kind" role="group" aria-label="反馈类型">{[["experience", "体验"], ["bug", "故障"], ["balance", "数值"], ["mobile", "手机端"]].map(([id, label]) => <button className={feedbackKind === id ? "active" : ""} type="button" onClick={() => setFeedbackKind(id)} key={id}>{label}</button>)}</div>
        <StableTextArea draftId="operations-feedback" value={feedback} onValueChange={setFeedback} maxLength={4000} placeholder="描述出现的问题或建议" aria-label="反馈内容" />
        <footer><span className={feedbackState === "failed" ? "warning" : feedbackState === "sent" ? "ready" : ""}>{feedbackMessage ?? `${feedback.length}/4000`}</span><button className="primary" type="button" disabled={!feedback.trim() || feedbackState === "sending" || cloudState === "offline"} onClick={() => void submitFeedback()}>{feedbackState === "sending" ? <Activity size={14} /> : <Upload size={14} />}{feedbackState === "sending" ? "提交中" : "提交反馈"}</button></footer>
      </section>
      <section className="support-onboarding-reset"><GraduationCap size={16} /><span><strong>渐进教学</strong><small>重新打开 5 步基础操作和从手动采矿到白糖、跨星物流与戴森云的 13 步进阶教学。</small></span><button type="button" onClick={() => { resetOnboarding(); window.location.reload(); }}>重新开始教学</button></section>
    </div>
  );
}

function WindowsNativeCoreBetaSetting(props: Pick<OperationsWorkspaceProps,
  "windowsNativeCoreBetaEnabled" | "windowsNativeCoreBetaStatus" | "onWindowsNativeCoreBetaEnabledChange">) {
  const { locale } = useAppLocale();
  const statusLabel = locale === "en" ? ({
    disabled: "Off",
    "awaiting-checkpoint": "Awaiting checkpoint",
    hashing: "Validating",
    "shadow-active": "Shadow active",
    "native-ready": "Gate pending",
    diverged: "Diverged",
    unavailable: "Unavailable",
    failed: "Failed",
  } as const)[props.windowsNativeCoreBetaStatus] : ({
    disabled: "关闭",
    "awaiting-checkpoint": "等待检查点",
    hashing: "正在校验",
    "shadow-active": "影子运行",
    "native-ready": "门禁待确认",
    diverged: "发现分叉",
    unavailable: "不可用",
    failed: "检查失败",
  } as const)[props.windowsNativeCoreBetaStatus];
  return (
    <div className="settings-panel settings-native-core-panel">
      <section className="settings-group settings-toggle-list" data-settings-category="performance">
        <header><Cpu size={14} /><span>{locale === "en" ? "Windows native core invitation Beta" : "Windows 原生核心邀请 Beta"}</span><small>{statusLabel}</small></header>
        <ToggleSetting
          checked={props.windowsNativeCoreBetaEnabled}
          label={locale === "en" ? "Validate the native simulation core in shadow mode" : "以影子模式校验原生模拟核心"}
          value={props.windowsNativeCoreBetaEnabled
            ? locale === "en" ? "Device-only · JavaScript remains authoritative" : "仅本机 · JavaScript 仍是权威"
            : locale === "en" ? "Off by default" : "默认关闭"}
          icon={<Cpu size={16} />}
          onChange={props.onWindowsNativeCoreBetaEnabledChange}
        />
        <p className={props.windowsNativeCoreBetaStatus === "diverged" || props.windowsNativeCoreBetaStatus === "failed" ? "settings-warning" : "settings-help"}>
          {locale === "en"
            ? "After the next full native checkpoint, the client streams an independent state proof and compares it with Rust. Shadow failures never replace the visible factory. Authority promotion remains locked until coverage and long-run gates pass."
            : "下一次完整原生检查点后，客户端会流式计算独立状态证明并与 Rust 对照。影子失败不会替换当前工厂；领域覆盖和长跑门禁通过前，原生权威切换保持锁定。"}
        </p>
      </section>
    </div>
  );
}

export function OperationsWorkspace(props: OperationsWorkspaceProps) {
  if (!props.open) return null;
  const unlockedCount = props.game.achievements.unlockedIds.length;
  return (
    <WorkspaceFrame className="operations-workspace" ariaLabel="运营中心" onRequestClose={props.onClose}>
      <header className="operations-header">
        <div className="operations-title">
          <i><Gauge size={20} /></i>
          <div><span>星系运行协议</span><strong>运营中心</strong></div>
        </div>
        <div className="operations-summary">
          <span className={props.alertCount > 0 ? "warning" : "positive"}><Bell size={13} />警报 <strong>{props.alertCount}</strong></span>
          <span><Trophy size={13} />成就 <strong>{unlockedCount}/{ACHIEVEMENTS.length}</strong></span>
        </div>
        <button className="operations-close" type="button" onClick={props.onClose} title="关闭运营中心" aria-label="关闭运营中心"><X size={18} /></button>
      </header>
      <nav className="operations-tabs" role="tablist" aria-label="运营中心视图">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const count = tab.id === "alerts" ? props.alertCount : tab.id === "achievements" ? unlockedCount : null;
          return (
            <button className={props.tab === tab.id ? "active" : ""} type="button" role="tab" aria-selected={props.tab === tab.id} key={tab.id} onClick={() => props.onTabChange(tab.id)}>
              <Icon size={15} /><span>{tab.label}</span>{count != null ? <strong>{count}</strong> : null}
            </button>
          );
        })}
      </nav>
      <div className="operations-body">
        {props.tab === "alerts" ? <AlertsPanel alerts={props.alerts} enabled={props.factoryAlertsEnabled} onSelect={props.onAlertSelect} onOpenTutorial={props.onOpenTutorial} /> : null}
        {props.tab === "achievements" ? <AchievementsPanel game={props.game} /> : null}
        {props.tab === "logistics" ? <LogisticsManagementPanel game={props.game} {...props.logisticsActions} /> : null}
        {props.tab === "settings" ? <SettingsPanel game={props.game} report={props.performanceReport} productionRefreshPreference={props.productionRefreshPreference} productionRefreshIntervalMs={props.productionRefreshIntervalMs} endgameExtremeMode={props.endgameExtremeMode} connectExpandAll={props.connectExpandAll} fullRealtimeSimulation={props.fullRealtimeSimulation} factoryAlertsEnabled={props.factoryAlertsEnabled} largeSaveAutosaveProtection={props.largeSaveAutosaveProtection} largeSaveAutosavePolicy={props.largeSaveAutosavePolicy} memoryAutoPauseEnabled={props.memoryAutoPauseEnabled} memoryAutoPauseThresholdMiB={props.memoryAutoPauseThresholdMiB} blueprintAllowOverlap={props.blueprintAllowOverlap} canvasDetailPreference={props.canvasDetailPreference} canvasOverlapPreference={props.canvasOverlapPreference} canvasInteractionDetailPreference={props.canvasInteractionDetailPreference} canvasDetailStage={props.canvasDetailStage} canvasVisibleNodeCount={props.canvasVisibleNodeCount} canvasStackGroupCount={props.canvasStackGroupCount} canvasStackHiddenCount={props.canvasStackHiddenCount} canvasPerformanceFeatures={props.canvasPerformanceFeatures} onEndgameExtremeModeChange={props.onEndgameExtremeModeChange} onConnectExpandAllChange={props.onConnectExpandAllChange} onFullRealtimeSimulationChange={props.onFullRealtimeSimulationChange} onFactoryAlertsEnabledChange={props.onFactoryAlertsEnabledChange} onLargeSaveAutosaveProtectionChange={props.onLargeSaveAutosaveProtectionChange} onMemoryAutoPauseEnabledChange={props.onMemoryAutoPauseEnabledChange} onMemoryAutoPauseThresholdChange={props.onMemoryAutoPauseThresholdChange} allowEditsDuringSave={props.allowEditsDuringSave} onAllowEditsDuringSaveChange={props.onAllowEditsDuringSaveChange} onBlueprintAllowOverlapChange={props.onBlueprintAllowOverlapChange} onCanvasDetailPreferenceChange={props.onCanvasDetailPreferenceChange} onCanvasOverlapPreferenceChange={props.onCanvasOverlapPreferenceChange} onCanvasInteractionDetailPreferenceChange={props.onCanvasInteractionDetailPreferenceChange} onCanvasPerformanceFeatureChange={props.onCanvasPerformanceFeatureChange} lineFindMode={props.lineFindMode} onLineFindModeChange={props.onLineFindModeChange} connectionPointSize={props.connectionPointSize} onConnectionPointSizeChange={props.onConnectionPointSizeChange} connectionHitArea={props.connectionHitArea} onConnectionHitAreaChange={props.onConnectionHitAreaChange} defaultBeltLanes={props.defaultBeltLanes} onDefaultBeltLanesChange={props.onDefaultBeltLanesChange} showRunLog={props.showRunLog} onRunLogChange={props.onRunLogChange} showItemHover={props.showItemHover} onItemHoverChange={props.onItemHoverChange} onProductionRefreshPreferenceChange={props.onProductionRefreshPreferenceChange} onChange={props.onSettingsChange} onRunBenchmark={props.onRunBenchmark} onOpenReleaseNotes={props.onOpenReleaseNotes} onOpenTutorial={props.onOpenTutorial} /> : null}
        {props.tab === "settings" && props.windowsNativeCoreAvailable ? <WindowsNativeCoreBetaSetting {...props} /> : null}
        {props.tab === "settings" ? <WindowsNativePerformancePolicySetting /> : null}
        {props.tab === "performance" ? <PerformancePanel game={props.game} snapshot={props.performanceMonitor} onStart={props.onStartPerformanceMonitor} onStop={props.onStopPerformanceMonitor} onClear={props.onClearPerformanceMonitor} onExport={props.onExportPerformanceMonitor} /> : null}
        {props.tab === "saves" ? <SavesPanel {...props} /> : null}
        {props.tab === "packs" ? <ContentPacksPanel game={props.game} registry={props.contentPackRegistry} validation={props.modValidation} onValidate={props.onValidateMod} onExportTemplate={props.onExportModTemplate} onRegister={props.onRegisterContentPack} onSetEnabled={props.onSetContentPackEnabled} onRemove={props.onRemoveContentPack} /> : null}
        {props.tab === "support" ? <SupportPanel game={props.game} report={props.performanceReport} /> : null}
      </div>
    </WorkspaceFrame>
  );
}
