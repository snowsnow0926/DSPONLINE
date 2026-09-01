import { Activity, AlertTriangle, BookOpen, Download, Gauge, HardDrive, Save, Settings2, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopNativeCoreOperationsAlertRow,
  DesktopNativeCoreOperationsWorkspaceProjectionRequest,
  DesktopNativeCoreOperationsWorkspaceProjectionResult,
  DesktopNativeCoreProjectionSubscriptionEvent,
  DesktopNativeCoreProjectionSubscriptionHandle,
  DesktopNativeCoreProjectionSubscriptionRequest,
  DesktopNativeProjectionSubscriptionDiagnostics,
  DesktopNativeOperationsSettingIntent,
} from "../desktop";
import { collectClientDiagnostics, downloadDiagnostics } from "../game/diagnostics";
import { decodeNativeCoreProjectionTransfer } from "../game/nativeCore";
import type { CanvasDetailPreference } from "../game/canvasDensityPresentation";
import type { ConnectionHitArea, ConnectionPointSize } from "../game/uiPreferences";
import type { AppLocale } from "../i18n/locale";
import type { OperationsTab } from "./OperationsWorkspace";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { WindowsNativePerformancePolicySetting } from "./WindowsNativePerformancePolicySetting";

type Tab = Extract<OperationsTab, "alerts" | "settings" | "performance" | "saves" | "support">;
type Status =
  | { phase: "loading" }
  | { phase: "ready"; projection: DesktopNativeCoreOperationsWorkspaceProjectionResult }
  | { phase: "unavailable"; message: string };

type AuthoritySettingsDraft = DesktopNativeCoreOperationsWorkspaceProjectionResult["settings"] & {
  scopeKey: string;
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
  tab: OperationsTab;
  onTabChange: (tab: OperationsTab) => void;
  identity: DesktopNativeCoreOperationsWorkspaceProjectionRequest | null;
  fetchProjection: ((request: DesktopNativeCoreOperationsWorkspaceProjectionRequest) => Promise<DesktopNativeCoreOperationsWorkspaceProjectionResult>) | null;
  subscribeProjection: ((
    request: DesktopNativeCoreProjectionSubscriptionRequest,
    listener: (event: DesktopNativeCoreProjectionSubscriptionEvent) => void | boolean | Promise<void | boolean>,
  ) => DesktopNativeCoreProjectionSubscriptionHandle) | null;
  fetchProjectionDiagnostics: (() => Promise<DesktopNativeProjectionSubscriptionDiagnostics>) | null;
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

function matchesScope(
  projection: DesktopNativeCoreOperationsWorkspaceProjectionResult,
  identity: DesktopNativeCoreOperationsWorkspaceProjectionRequest,
) {
  return projection.sessionId === identity.sessionId && projection.runId === identity.runId &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint && projection.truncated === false;
}

function matchesScopeKey(
  left: DesktopNativeCoreOperationsWorkspaceProjectionRequest,
  right: DesktopNativeCoreOperationsWorkspaceProjectionRequest,
) {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.expectedRegistryFingerprint === right.expectedRegistryFingerprint;
}

function identityKey(identity: DesktopNativeCoreOperationsWorkspaceProjectionRequest | null) {
  return identity
    ? `${identity.sessionId}\0${identity.runId}\0${identity.expectedRevision}\0${identity.expectedRegistryFingerprint}`
    : "missing";
}

function unavailable(
  identity: NativeOperationsWorkspaceProps["identity"],
  fetchProjection: NativeOperationsWorkspaceProps["fetchProjection"],
  subscribeProjection: NativeOperationsWorkspaceProps["subscribeProjection"],
) {
  if (!identity) return "原生玩家权威 lineage 尚未就绪；运营中心不会读取旧 renderer GameState。";
  if (!fetchProjection && !subscribeProjection) return "当前 Windows Host 不支持运营中心薄投影；页面已安全关闭。";
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
    scopeKey: projectionScopeKey(projection),
    ...projection.settings,
    productionBufferLimitInput: String(projection.settings.productionBufferLimit),
    logisticsBufferLimitInput: String(projection.settings.logisticsBufferLimit),
    beltBufferLimitInput: String(projection.settings.beltBufferLimit),
    proliferatorBufferLimitInput: String(projection.settings.proliferatorBufferLimit),
  };
}

export function NativeOperationsWorkspace(props: NativeOperationsWorkspaceProps) {
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [settingsDraft, setSettingsDraft] = useState<AuthoritySettingsDraft | null>(null);
  const [pendingCommit, setPendingCommit] = useState<PendingCommit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnosticStartedAt, setDiagnosticStartedAt] = useState<number | null>(null);
  const [diagnosticSeconds, setDiagnosticSeconds] = useState(0);
  const [projectionDiagnostics, setProjectionDiagnostics] =
    useState<DesktopNativeProjectionSubscriptionDiagnostics | null>(null);
  const commitGeneration = useRef(0);
  const commitLocked = useRef(false);
  const subscriptionRef = useRef<DesktopNativeCoreProjectionSubscriptionHandle | null>(null);
  const subscriptionRevisionRef = useRef<number | null>(null);
  const currentIdentityRef = useRef(props.identity);
  currentIdentityRef.current = props.identity;
  const currentIdentityKey = identityKey(props.identity);
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
    if (!props.identity || props.subscribeProjection || !props.fetchProjection) {
      if (!props.identity || !props.subscribeProjection && !props.fetchProjection) {
        setStatus({ phase: "unavailable", message: unavailable(
          props.identity,
          props.fetchProjection,
          props.subscribeProjection,
        ) });
      }
      return;
    }
    const identity = props.identity;
    setStatus((current) => current.phase === "ready" && matchesScope(current.projection, identity)
      ? current
      : { phase: "loading" });
    void props.fetchProjection(identity).then((projection) => {
      const currentIdentity = currentIdentityRef.current;
      if (!currentIdentity || !matchesScope(projection, currentIdentity) || projection.revision > currentIdentity.expectedRevision) return;
      if (!matchesIdentity(projection, identity)) {
        if (identityKey(currentIdentity) !== identityKey(identity)) return;
        setStatus((current) => current.phase === "ready" && matchesScope(current.projection, currentIdentity)
          ? current
          : { phase: "unavailable", message: unavailable(identity, props.fetchProjection, props.subscribeProjection) });
        return;
      }
      setStatus((current) => current.phase === "ready" && matchesScope(current.projection, currentIdentity) &&
        current.projection.revision >= projection.revision
        ? current
        : { phase: "ready", projection });
    }).catch(() => {
      const currentIdentity = currentIdentityRef.current;
      if (!currentIdentity || identityKey(currentIdentity) !== identityKey(identity)) return;
      setStatus((current) => current.phase === "ready" && matchesScope(current.projection, currentIdentity)
        ? current
        : { phase: "unavailable", message: unavailable(identity, props.fetchProjection, props.subscribeProjection) });
    });
  }, [currentIdentityKey, props.fetchProjection, props.open, props.subscribeProjection]);

  useEffect(() => {
    if (!props.open || !props.identity || !props.subscribeProjection) return;
    const initialIdentity = props.identity;
    setStatus((current) => current.phase === "ready" && matchesScope(current.projection, initialIdentity)
      ? current
      : { phase: "loading" });
    let handle: DesktopNativeCoreProjectionSubscriptionHandle;
    try {
      handle = props.subscribeProjection({
        sessionId: initialIdentity.sessionId,
        channel: "telemetry",
        projectionType: "operations-workspace-v1",
        payload: {
          runId: initialIdentity.runId,
          expectedRevision: initialIdentity.expectedRevision,
          expectedRegistryFingerprint: initialIdentity.expectedRegistryFingerprint,
        },
      }, async (event) => {
        if (subscriptionRef.current !== handle) return true;
        if (event.kind === "error") {
          if (!event.recoverable) {
            const currentIdentity = currentIdentityRef.current;
            if (currentIdentity && matchesScopeKey(currentIdentity, initialIdentity)) {
              setStatus((current) => current.phase === "ready" ? current : {
                phase: "unavailable",
                message: unavailable(currentIdentity, props.fetchProjection, props.subscribeProjection),
              });
            }
          }
          return true;
        }
        const projection = await decodeNativeCoreProjectionTransfer<DesktopNativeCoreOperationsWorkspaceProjectionResult>(
          event.transfer,
          { sessionId: initialIdentity.sessionId, projectionType: "operations-workspace-v1" },
        );
        const currentIdentity = currentIdentityRef.current;
        if (!currentIdentity || !matchesScope(projection, currentIdentity) ||
            projection.revision > currentIdentity.expectedRevision) return true;
        setStatus((current) => current.phase === "ready" &&
          matchesScope(current.projection, currentIdentity) &&
          current.projection.revision >= projection.revision
          ? current
          : { phase: "ready", projection });
        return true;
      });
    } catch {
      setStatus({
        phase: "unavailable",
        message: unavailable(initialIdentity, props.fetchProjection, props.subscribeProjection),
      });
      return;
    }
    subscriptionRef.current = handle;
    subscriptionRevisionRef.current = initialIdentity.expectedRevision;
    return () => {
      if (subscriptionRef.current === handle) {
        subscriptionRef.current = null;
        subscriptionRevisionRef.current = null;
      }
      handle.close();
    };
  }, [identityScopeKey, props.fetchProjection, props.open, props.subscribeProjection]);

  useEffect(() => {
    const handle = subscriptionRef.current;
    const identity = props.identity;
    if (!props.open || !handle || !identity ||
        subscriptionRevisionRef.current === identity.expectedRevision) return;
    subscriptionRevisionRef.current = identity.expectedRevision;
    setStatus((current) => current.phase === "ready" && matchesScope(current.projection, identity)
      ? current
      : { phase: "loading" });
    try {
      handle.update({
        runId: identity.runId,
        expectedRevision: identity.expectedRevision,
        expectedRegistryFingerprint: identity.expectedRegistryFingerprint,
      });
    } catch {
      setStatus((current) => current.phase === "ready" ? current : {
        phase: "unavailable",
        message: unavailable(identity, props.fetchProjection, props.subscribeProjection),
      });
    }
  }, [currentIdentityKey, props.fetchProjection, props.identity, props.open, props.subscribeProjection]);

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

  useEffect(() => {
    if (!props.open || props.tab !== "performance" || !props.fetchProjectionDiagnostics) return;
    let active = true;
    const refresh = () => void props.fetchProjectionDiagnostics?.().then((value) => {
      if (!active || value?.schemaVersion !== 1 || !Number.isSafeInteger(value.acknowledgedFrames) ||
          !Number.isFinite(value.gateC?.transportP95Ms) || !Number.isFinite(value.gateC?.frameBudgetRatio) ||
          !["insufficient-samples", "bounded-message-port-retained", "shared-memory-evaluation-required"]
            .includes(value.gateC?.decision)) return;
      setProjectionDiagnostics(value);
    }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [props.fetchProjectionDiagnostics, props.open, props.tab]);

  const projection = status.phase === "ready" && props.identity && matchesScope(status.projection, props.identity)
    ? status.projection : null;
  const projectionKey = projection ? projectionIdentityKey(projection) : "missing";
  const projectionScope = projection ? projectionScopeKey(projection) : "missing";
  const tab: Tab = TABS.some((item) => item.id === props.tab) ? props.tab as Tab : "alerts";
  const activeSettingsDraft = projection
    ? settingsDraft?.scopeKey === projectionScope ? settingsDraft : createSettingsDraft(projection)
    : null;

  useEffect(() => {
    if (!projection) return;
    setSettingsDraft((current) => current?.scopeKey === projectionScope ? current : createSettingsDraft(projection));
  }, [projection, projectionScope]);

  useEffect(() => {
    if (!projection || !pendingCommit || pendingCommit.phase !== "awaiting-projection") return;
    if (projectionScopeKey(projection) !== `${pendingCommit.sessionId}\0${pendingCommit.runId}\0${pendingCommit.registryFingerprint}` ||
      projection.revision <= pendingCommit.revision) return;
    commitLocked.current = false;
    setPendingCommit(null);
    setSettingsDraft(createSettingsDraft(projection));
    setMessage(`设置已写入 Rust revision ${projection.revision}。`);
  }, [pendingCommit, projection, projectionKey]);

  const alertRows = useMemo(() => props.factoryAlertsEnabled && projection?.alerts.status === "complete"
    ? projection.alerts.rows : [], [projection, props.factoryAlertsEnabled]);
  if (!props.open) return null;

  const commit = (intent: DesktopNativeOperationsSettingIntent) => {
    const identity = currentIdentityRef.current;
    if (!projection || !identity || !matchesScope(projection, identity) || !props.commitSetting || commitLocked.current) return false;
    const token = ++commitGeneration.current;
    const committedProjection = projection;
    commitLocked.current = true;
    setPendingCommit({
      token,
      phase: "committing",
      sessionId: identity.sessionId,
      runId: identity.runId,
      revision: identity.expectedRevision,
      registryFingerprint: identity.expectedRegistryFingerprint,
    });
    setMessage(null);
    void props.commitSetting({
      expectedSessionId: identity.sessionId,
      expectedRunId: identity.runId,
      expectedRevision: identity.expectedRevision,
      expectedRegistryFingerprint: identity.expectedRegistryFingerprint,
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
      {TABS.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => props.onTabChange(item.id)}>{item.label}</button>)}
    </nav>
    {projection && props.identity && projection.revision !== props.identity.expectedRevision
      ? <p role="status" className="operations-notice">正在读取 Rust revision {props.identity.expectedRevision}；当前保持显示已验证的 revision {projection.revision}，不会退回 JavaScript 存档。</p>
      : null}
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
            setSettingsDraft((current) => current?.scopeKey === projectionScope ? { ...current, simulationSpeed: value } : current);
          }
        }}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
        <label>科技布局<select disabled={pending} value={activeSettingsDraft.technologyLayout} onChange={(event) => {
          const value = event.target.value as "standard" | "compact";
          if (commit({ type: "set-technology-layout", value })) {
            setSettingsDraft((current) => current?.scopeKey === projectionScope ? { ...current, technologyLayout: value } : current);
          }
        }}><option value="standard">标准</option><option value="compact">紧凑</option></select></label>
        <label>默认传送带路线<select disabled={pending} value={activeSettingsDraft.defaultBeltRouteMode} onChange={(event) => {
          const value = event.target.value as "auto" | "bezier" | "upper" | "lower";
          if (commit({ type: "set-default-belt-route-mode", value })) {
            setSettingsDraft((current) => current?.scopeKey === projectionScope ? { ...current, defaultBeltRouteMode: value } : current);
          }
        }}><option value="auto">自动</option><option value="bezier">曲线</option><option value="upper">上绕</option><option value="lower">下绕</option></select></label>
        {([
          ["生产缓冲", "set-production-buffer-limit", "productionBufferLimit", "productionBufferLimitInput", 1000],
          ["物流缓冲", "set-logistics-buffer-limit", "logisticsBufferLimit", "logisticsBufferLimitInput", 1000],
          ["传送带缓冲", "set-belt-buffer-limit", "beltBufferLimit", "beltBufferLimitInput", 1000],
          ["增产剂缓冲", "set-proliferator-buffer-limit", "proliferatorBufferLimit", "proliferatorBufferLimitInput", 1],
        ] as const).map(([label, type, valueKey, inputKey, min]) => <label key={type}>{label}<input type="number" min={min} max={100_000_000} step={1} disabled={pending} value={activeSettingsDraft[inputKey]} onChange={(event) => {
          const input = event.currentTarget.value;
          setSettingsDraft((current) => current?.scopeKey === projectionScope ? { ...current, [inputKey]: input } : current);
        }} onBlur={() => {
          const next = Number(activeSettingsDraft[inputKey]);
          if (Number.isSafeInteger(next) && next >= min && next <= 100_000_000 && next !== activeSettingsDraft[valueKey]) commit({ type, value: next });
          else setSettingsDraft((current) => current?.scopeKey === projectionScope ? { ...current, [inputKey]: String(activeSettingsDraft[valueKey]) } : current);
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
        {projection.factoryExecution ? <>
          <p data-native-factory-execution>
            最近结算 {projection.factoryExecution.simulationSeconds.toLocaleString()} 模拟秒 / {projection.factoryExecution.steps.toLocaleString()} 步；
            写入 {projection.factoryExecution.writerUniqueRows.toLocaleString()} / {projection.factoryExecution.entityCount.toLocaleString()} 个实体；
            线程 {projection.factoryExecution.observedWorkerCount}/{projection.factoryExecution.workerLimit}。
          </p>
          <p>
            稠密退化 {projection.factoryExecution.stageScans.reduce((sum, stage) => sum + stage.denseFallbacks, 0).toLocaleString()} 次 ·
            目录退化 {projection.factoryExecution.stageScans.reduce((sum, stage) => sum + stage.directoryFallbacks, 0).toLocaleString()} 次 ·
            已证明跳过 {projection.factoryExecution.stageScans.reduce((sum, stage) => sum + stage.stableRowsSkipped, 0).toLocaleString()} 行。
          </p>
        </> : <p>当前 revision 没有可用的原生工厂结算诊断。</p>}
        <p><Activity size={14} /> 60 秒监测只观察 renderer 设备表现，不是游戏权威数据。</p>
        {projectionDiagnostics ? <p data-native-projection-gate-c>
          投影通道：确认 {projectionDiagnostics.acknowledgedFrames.toLocaleString()} 帧，合并 {projectionDiagnostics.coalescedFrames.toLocaleString()} 帧；
          传输 P95 {projectionDiagnostics.gateC.transportP95Ms.toFixed(2)} ms（60 FPS 帧预算的 {(projectionDiagnostics.gateC.frameBudgetRatio * 100).toFixed(1)}%）；
          Gate C：{projectionDiagnostics.gateC.decision === "bounded-message-port-retained"
            ? "保留有界 MessagePort"
            : projectionDiagnostics.gateC.decision === "shared-memory-evaluation-required"
              ? "需要评估共享内存环"
              : "样本不足"}。
        </p> : <p>投影 Gate C 尚无足够的本机订阅样本。</p>}
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
          nativeOperations: { revision: projection.revision, registryFingerprint: projection.registryFingerprint, summary: projection.summary, alerts: { ...projection.alerts, rows: undefined }, factoryExecution: projection.factoryExecution },
          rendererDiagnostic: { durationSeconds: diagnosticSeconds, authoritative: false },
        })}>导出无 GameState 诊断</button>
        <p>成就、物流改线、内容包校验/注册/启用/移除尚无安全语义链，当前只读不可用。</p>
      </section> : null}
    </main>}
  </WorkspaceFrame>;
}
