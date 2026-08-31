import { Activity, AlertTriangle, BookOpen, Download, Gauge, HardDrive, Save, Settings2, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopNativeCoreOperationsAlertRow,
  DesktopNativeCoreOperationsWorkspaceProjectionRequest,
  DesktopNativeCoreOperationsWorkspaceProjectionResult,
  DesktopNativeOperationsSettingIntent,
} from "../desktop";
import { collectClientDiagnostics, downloadDiagnostics } from "../game/diagnostics";
import type { CanvasDetailPreference } from "../game/canvasDensityPresentation";
import type { ConnectionHitArea, ConnectionPointSize } from "../game/uiPreferences";
import type { AppLocale } from "../i18n/locale";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { WindowsNativePerformancePolicySetting } from "./WindowsNativePerformancePolicySetting";

type Tab = "alerts" | "settings" | "performance" | "saves" | "support";
type Status =
  | { phase: "loading" }
  | { phase: "ready"; projection: DesktopNativeCoreOperationsWorkspaceProjectionResult }
  | { phase: "unavailable"; message: string };

type AuthoritySettingsDraft = DesktopNativeCoreOperationsWorkspaceProjectionResult["settings"] & {
  identityKey: string;
  productionBufferLimitInput: string;
  logisticsBufferLimitInput: string;
  beltBufferLimitInput: string;
  proliferatorBufferLimitInput: string;
};

type PendingCommit = {
  token: number;
  phase: "committing" | "awaiting-projection";
  sessionId: string;
  runId: string;
  revision: number;
  registryFingerprint: string;
};

export interface NativeOperationsWorkspaceProps {
  open: boolean;
  identity: DesktopNativeCoreOperationsWorkspaceProjectionRequest | null;
  fetchProjection: ((request: DesktopNativeCoreOperationsWorkspaceProjectionRequest) => Promise<DesktopNativeCoreOperationsWorkspaceProjectionResult>) | null;
  commitSetting: ((request: {
    expectedSessionId: string;
    expectedRunId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    intent: DesktopNativeOperationsSettingIntent;
  }) => Promise<unknown>) | null;
  theme: "dark" | "light" | "system";
  fontScale: 0.8 | 1 | 1.25 | 1.5 | 2;
  factoryAlertsEnabled: boolean;
  canvasDetailPreference: CanvasDetailPreference;
  connectionPointSize: ConnectionPointSize;
  connectionHitArea: ConnectionHitArea;
  defaultBeltLanes: number;
  locale: AppLocale;
  onThemeChange: (value: "dark" | "light" | "system") => void;
  onFontScaleChange: (value: 0.8 | 1 | 1.25 | 1.5 | 2) => void;
  onFactoryAlertsEnabledChange: (value: boolean) => void;
  onCanvasDetailPreferenceChange: (value: CanvasDetailPreference) => void;
  onConnectionPointSizeChange: (value: ConnectionPointSize) => void;
  onConnectionHitAreaChange: (value: ConnectionHitArea) => void;
  onDefaultBeltLanesChange: (value: number) => void;
  onLocaleChange: (value: AppLocale) => void;
  onManualCheckpoint: () => Promise<unknown> | void;
  onExportV47: () => void;
  onAlertSelect: (row: DesktopNativeCoreOperationsAlertRow) => void;
  onOpenTutorial: () => void;
  onOpenReleaseNotes: () => void;
  onClose: () => void;
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "alerts", label: "警报" },
  { id: "settings", label: "设置" },
  { id: "performance", label: "性能" },
  { id: "saves", label: "存档" },
  { id: "support", label: "帮助" },
];

function matchesIdentity(
  projection: DesktopNativeCoreOperationsWorkspaceProjectionResult,
  identity: DesktopNativeCoreOperationsWorkspaceProjectionRequest,
) {
  return projection.sessionId === identity.sessionId && projection.runId === identity.runId &&
    projection.revision === identity.expectedRevision &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint && projection.truncated === false;
}

function unavailable(identity: NativeOperationsWorkspaceProps["identity"], fetchProjection: NativeOperationsWorkspaceProps["fetchProjection"]) {
  if (!identity) return "原生玩家权威 lineage 尚未就绪；运营中心不会读取旧 renderer GameState。";
  if (!fetchProjection) return "当前 Windows Host 不支持运营中心薄投影；页面已安全关闭。";
  return "运营投影未通过 session/run/revision/registry 或完整性校验；页面已安全关闭。";
}

function projectionIdentityKey(projection: DesktopNativeCoreOperationsWorkspaceProjectionResult) {
  return `${projection.sessionId}\0${projection.runId}\0${projection.revision}\0${projection.registryFingerprint}`;
}

function projectionScopeKey(projection: DesktopNativeCoreOperationsWorkspaceProjectionResult) {
  return `${projection.sessionId}\0${projection.runId}\0${projection.registryFingerprint}`;
}

function createSettingsDraft(projection: DesktopNativeCoreOperationsWorkspaceProjectionResult): AuthoritySettingsDraft {
  return {
    identityKey: projectionIdentityKey(projection),
    ...projection.settings,
    productionBufferLimitInput: String(projection.settings.productionBufferLimit),
    logisticsBufferLimitInput: String(projection.settings.logisticsBufferLimit),
    beltBufferLimitInput: String(projection.settings.beltBufferLimit),
    proliferatorBufferLimitInput: String(projection.settings.proliferatorBufferLimit),
  };
}

export function NativeOperationsWorkspace(props: NativeOperationsWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("alerts");
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [settingsDraft, setSettingsDraft] = useState<AuthoritySettingsDraft | null>(null);
  const [pendingCommit, setPendingCommit] = useState<PendingCommit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnosticStartedAt, setDiagnosticStartedAt] = useState<number | null>(null);
  const [diagnosticSeconds, setDiagnosticSeconds] = useState(0);
  const requestGeneration = useRef(0);
  const commitGeneration = useRef(0);
  const commitLocked = useRef(false);
  const identityKey = props.identity
    ? `${props.identity.sessionId}\0${props.identity.runId}\0${props.identity.expectedRevision}\0${props.identity.expectedRegistryFingerprint}`
    : "missing";
  const identityScopeKey = props.identity
    ? `${props.identity.sessionId}\0${props.identity.runId}\0${props.identity.expectedRegistryFingerprint}`
    : "missing";

  useEffect(() => {
    commitGeneration.current += 1;
    commitLocked.current = false;
    setPendingCommit(null);
    setSettingsDraft(null);
    setMessage(null);
  }, [identityScopeKey, props.open]);

  useEffect(() => {
    if (!props.open) return;
    const generation = ++requestGeneration.current;
    if (!props.identity || !props.fetchProjection) {
      setStatus({ phase: "unavailable", message: unavailable(props.identity, props.fetchProjection) });
      return;
    }
    const identity = props.identity;
    setStatus({ phase: "loading" });
    void props.fetchProjection(identity).then((projection) => {
      if (requestGeneration.current !== generation) return;
      setStatus(matchesIdentity(projection, identity)
        ? { phase: "ready", projection }
        : { phase: "unavailable", message: unavailable(identity, props.fetchProjection) });
    }).catch(() => {
      if (requestGeneration.current === generation) {
        setStatus({ phase: "unavailable", message: unavailable(identity, props.fetchProjection) });
      }
    });
    return () => { if (requestGeneration.current === generation) requestGeneration.current += 1; };
  }, [identityKey, props.fetchProjection, props.open]);

  useEffect(() => {
    if (diagnosticStartedAt === null) return;
    const update = () => {
      const elapsed = Math.min(60, Math.floor((performance.now() - diagnosticStartedAt) / 1000));
      setDiagnosticSeconds(elapsed);
      if (elapsed >= 60) setDiagnosticStartedAt(null);
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [diagnosticStartedAt]);

  const projection = status.phase === "ready" && props.identity && matchesIdentity(status.projection, props.identity)
    ? status.projection : null;
  const projectionKey = projection ? projectionIdentityKey(projection) : "missing";
  const activeSettingsDraft = projection
    ? settingsDraft?.identityKey === projectionKey ? settingsDraft : createSettingsDraft(projection)
    : null;

  useEffect(() => {
    setSettingsDraft(projection ? createSettingsDraft(projection) : null);
  }, [projectionKey]);

  useEffect(() => {
    if (!projection || !pendingCommit || pendingCommit.phase !== "awaiting-projection") return;
    if (projectionScopeKey(projection) !== `${pendingCommit.sessionId}\0${pendingCommit.runId}\0${pendingCommit.registryFingerprint}` ||
      projection.revision <= pendingCommit.revision) return;
    commitLocked.current = false;
    setPendingCommit(null);
    setMessage(`设置已写入 Rust revision ${projection.revision}。`);
  }, [pendingCommit, projection, projectionKey]);

  const alertRows = useMemo(() => props.factoryAlertsEnabled && projection?.alerts.status === "complete"
    ? projection.alerts.rows : [], [projection, props.factoryAlertsEnabled]);
  if (!props.open) return null;

  const commit = (intent: DesktopNativeOperationsSettingIntent) => {
    if (!projection || !props.commitSetting || commitLocked.current) return false;
    const token = ++commitGeneration.current;
    const committedProjection = projection;
    commitLocked.current = true;
    setPendingCommit({
      token,
      phase: "committing",
      sessionId: projection.sessionId,
      runId: projection.runId,
      revision: projection.revision,
      registryFingerprint: projection.registryFingerprint,
    });
    setMessage(null);
    void props.commitSetting({
      expectedSessionId: projection.sessionId,
      expectedRunId: projection.runId,
      expectedRevision: projection.revision,
      expectedRegistryFingerprint: projection.registryFingerprint,
      intent,
    }).then(() => {
      if (commitGeneration.current !== token) return;
      setPendingCommit((current) => current?.token === token ? { ...current, phase: "awaiting-projection" } : current);
      setMessage("设置已收到 Rust durable ACK；正在等待新 authority revision 投影。");
    }).catch(() => {
      if (commitGeneration.current !== token) return;
      commitLocked.current = false;
      setPendingCommit(null);
      setSettingsDraft(createSettingsDraft(committedProjection));
      setMessage("设置未通过当前 lineage/叶字段证明，未应用。");
    });
    return true;
  };

  const pending = pendingCommit !== null;

  return <WorkspaceFrame className="operations-workspace native-operations-workspace" ariaLabel="原生运营中心" onRequestClose={props.onClose}>
    <header className="operations-header">
      <div><small>RUST 权威{projection ? ` · REV ${projection.revision}` : ""}</small><h2>运营中心</h2></div>
      <button type="button" onClick={props.onClose} aria-label="关闭运营中心"><X size={18} /></button>
    </header>
    <nav className="operations-tabs" aria-label="运营中心页面">
      {TABS.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </nav>
    {!projection ? <div className="workspace-loading" role={status.phase === "loading" ? "status" : "alert"}>
      {status.phase === "loading" ? <i /> : <ShieldAlert size={22} />}
      <span>{status.phase === "loading" ? "正在读取同 revision Rust 运营投影…" : status.phase === "unavailable" ? status.message : "投影不可用"}</span>
    </div> : <main className="operations-content">
      {message ? <p role="status" className="operations-notice">{message}</p> : null}
      {tab === "alerts" ? <section className="settings-section">
        <h3><AlertTriangle size={17} /> 工厂警报</h3>
        <p>同一 Rust revision 的保守状态。无法证明的实体按严重警报处理。</p>
        {!props.factoryAlertsEnabled ? <p>设备级警报展示已关闭。</p>
          : projection.alerts.status === "overflow" ? <div role="alert"><strong>警报超过 {projection.limits.alertRows} 条</strong><p>为避免展示部分真相，本页不会显示任何行。严重 {projection.alerts.criticalCount}，警告 {projection.alerts.warningCount}。</p></div>
            : alertRows.length === 0 ? <p>当前 revision 没有警报。</p>
              : <div className="alert-list">{alertRows.map((row) => <button type="button" key={row.entityId} onClick={() => props.onAlertSelect(row)}>
                <span>{row.severity === "critical" ? "严重" : "警告"}</span><strong>{row.label}</strong><small>{row.planetId} · {row.entityId}</small>
              </button>)}</div>}
      </section> : null}
      {tab === "settings" && activeSettingsDraft ? <section className="settings-section">
        <h3><Settings2 size={17} /> 权威叶设置</h3>
        <p>仅这 7 个单字段意图可写；资源模式、难度、能量模式及其他复合切换均不可用。</p>
        <label>模拟速度<select disabled={pending} value={activeSettingsDraft.simulationSpeed} onChange={(event) => {
          const value = Number(event.target.value) as 1 | 2 | 4;
          if (commit({ type: "set-simulation-speed", value })) {
            setSettingsDraft((current) => current?.identityKey === projectionKey ? { ...current, simulationSpeed: value } : current);
          }
        }}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
        <label>科技布局<select disabled={pending} value={activeSettingsDraft.technologyLayout} onChange={(event) => {
          const value = event.target.value as "standard" | "compact";
          if (commit({ type: "set-technology-layout", value })) {
            setSettingsDraft((current) => current?.identityKey === projectionKey ? { ...current, technologyLayout: value } : current);
          }
        }}><option value="standard">标准</option><option value="compact">紧凑</option></select></label>
        <label>默认传送带路线<select disabled={pending} value={activeSettingsDraft.defaultBeltRouteMode} onChange={(event) => {
          const value = event.target.value as "auto" | "bezier" | "upper" | "lower";
          if (commit({ type: "set-default-belt-route-mode", value })) {
            setSettingsDraft((current) => current?.identityKey === projectionKey ? { ...current, defaultBeltRouteMode: value } : current);
          }
        }}><option value="auto">自动</option><option value="bezier">曲线</option><option value="upper">上绕</option><option value="lower">下绕</option></select></label>
        {([
          ["生产缓冲", "set-production-buffer-limit", "productionBufferLimit", "productionBufferLimitInput", 1000],
          ["物流缓冲", "set-logistics-buffer-limit", "logisticsBufferLimit", "logisticsBufferLimitInput", 1000],
          ["传送带缓冲", "set-belt-buffer-limit", "beltBufferLimit", "beltBufferLimitInput", 1000],
          ["增产剂缓冲", "set-proliferator-buffer-limit", "proliferatorBufferLimit", "proliferatorBufferLimitInput", 1],
        ] as const).map(([label, type, valueKey, inputKey, min]) => <label key={type}>{label}<input type="number" min={min} max={100_000_000} step={1} disabled={pending} value={activeSettingsDraft[inputKey]} onChange={(event) => {
          const input = event.currentTarget.value;
          setSettingsDraft((current) => current?.identityKey === projectionKey ? { ...current, [inputKey]: input } : current);
        }} onBlur={() => {
          const next = Number(activeSettingsDraft[inputKey]);
          if (Number.isSafeInteger(next) && next >= min && next <= 100_000_000 && next !== activeSettingsDraft[valueKey]) commit({ type, value: next });
          else setSettingsDraft((current) => current?.identityKey === projectionKey ? { ...current, [inputKey]: String(activeSettingsDraft[valueKey]) } : current);
        }} /></label>)}
        <hr />
        <h3>设备 / renderer 偏好</h3>
        <label>主题<select value={props.theme} onChange={(event) => props.onThemeChange(event.target.value as "dark" | "light" | "system")}><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">浅色</option></select></label>
        <label>字号<select value={props.fontScale} onChange={(event) => props.onFontScaleChange(Number(event.target.value) as 0.8 | 1 | 1.25 | 1.5 | 2)}>{[0.8, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></label>
        <label>语言<select value={props.locale} onChange={(event) => props.onLocaleChange(event.target.value as AppLocale)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label><input type="checkbox" checked={props.factoryAlertsEnabled} onChange={(event) => props.onFactoryAlertsEnabledChange(event.target.checked)} /> 显示工厂警报（设备偏好）</label>
        <label>画布细节<select value={props.canvasDetailPreference} onChange={(event) => props.onCanvasDetailPreferenceChange(event.target.value as CanvasDetailPreference)}><option value="auto">自动</option><option value="full">完整</option><option value="medium">中等</option><option value="minimal">最简</option></select></label>
        <label>连接点尺寸<select value={props.connectionPointSize} onChange={(event) => props.onConnectionPointSizeChange(event.target.value as ConnectionPointSize)}><option value="default">标准</option><option value="large25">放大 25%</option><option value="large50">放大 50%</option></select></label>
        <label>连接命中区<select value={props.connectionHitArea} onChange={(event) => props.onConnectionHitAreaChange(event.target.value as ConnectionHitArea)}><option value="auto">自动</option><option value="standard">标准</option><option value="large">大</option><option value="huge">超大</option></select></label>
        <label>默认传送带并联数<select value={props.defaultBeltLanes} onChange={(event) => props.onDefaultBeltLanesChange(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <p><strong>明确不可用：</strong>资源模式、难度、能量模式、自动存档规则、MOD 注册/启用/移除。</p>
      </section> : null}
      {tab === "performance" ? <section className="settings-section">
        <h3><Gauge size={17} /> 工厂规模与本地诊断</h3>
        <p>实体 {projection.summary.entityCount.toLocaleString()} · 传送带 {projection.summary.beltCount.toLocaleString()} · 施工队列 {projection.summary.constructionQueueCount.toLocaleString()}</p>
        <p>当前星球 {projection.summary.activePlanetId}：实体 {projection.summary.activePlanetEntityCount.toLocaleString()}，传送带 {projection.summary.activePlanetBeltCount.toLocaleString()}。</p>
        <p><Activity size={14} /> 60 秒监测只观察 renderer 设备表现，不是游戏权威数据。</p>
        <WindowsNativePerformancePolicySetting />
        <button type="button" disabled={diagnosticStartedAt !== null} onClick={() => { setDiagnosticSeconds(0); setDiagnosticStartedAt(performance.now()); }}>开始 60 秒本地监测</button>
        <span>{diagnosticStartedAt !== null ? `监测中 ${diagnosticSeconds}/60 秒` : diagnosticSeconds === 60 ? "监测完成" : "尚未开始"}</span>
      </section> : null}
      {tab === "saves" ? <section className="settings-section">
        <h3><HardDrive size={17} /> 原生权威存档</h3>
        <button type="button" onClick={() => void props.onManualCheckpoint()}><Save size={15} /> 手动创建 durable checkpoint</button>
        <button type="button" onClick={props.onExportV47}><Download size={15} /> 流式导出当前 v47</button>
        <p>下列入口在活动 authority 下明确禁用，且本组件没有对应 callback：</p>
        <button type="button" disabled>导入 / 确认导入</button><button type="button" disabled>恢复 / 覆盖</button><button type="button" disabled>槽位保存 / 载入</button><button type="button" disabled>快照回滚</button>
      </section> : null}
      {tab === "support" ? <section className="settings-section">
        <h3><BookOpen size={17} /> 帮助与诊断</h3>
        <button type="button" onClick={props.onOpenTutorial}>打开教程</button>
        <button type="button" onClick={props.onOpenReleaseNotes}>查看版本说明</button>
        <button type="button" onClick={() => void downloadDiagnostics({
          ...collectClientDiagnostics(undefined),
          nativeOperations: { revision: projection.revision, registryFingerprint: projection.registryFingerprint, summary: projection.summary, alerts: { ...projection.alerts, rows: undefined } },
          rendererDiagnostic: { durationSeconds: diagnosticSeconds, authoritative: false },
        })}>导出无 GameState 诊断</button>
        <p>成就、物流改线、内容包校验/注册/启用/移除尚无安全语义链，当前只读不可用。</p>
      </section> : null}
    </main>}
  </WorkspaceFrame>;
}
