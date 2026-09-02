import {
  Activity,
  Cloud,
  CloudOff,
  Database,
  Eye,
  EyeOff,
  Factory,
  Globe2,
  LockKeyhole,
  LogIn,
  LogOut,
  Orbit,
  Plus,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getDesktopBridge, type DesktopNativePlayerAuthorityCloudProgress } from "../desktop";
import { ACCOUNT_AVATARS, getActiveAccount, type AccountProfileChanges, type AccountState } from "../game/account";
import { getCloudToken, loginCloudAccount, logoutCloudAccount, resumeCloudSession, type CloudSession } from "../game/cloud";
import type {
  NativeCampaignGalaxyWorkspaceIdentity,
  NativeCampaignGalaxyWorkspaceReadStatus,
  NativeGalaxyWorkspaceFrame,
} from "../game/nativeCampaignGalaxyWorkspaceStore";
import type { NativeProjectedGalacticExportIntent } from "../game/nativeProjectedGalacticExportCommands";
import { AccessibleDialog } from "./AccessibleDialog";
import { WorkspaceFrame } from "./WorkspaceFrame";

type NativeGalaxyTab = "overview" | "exports" | "account" | "cloud";

const EXPORT_LABELS = {
  universe_archive: { name: "宇宙矩阵档案", item: "宇宙矩阵" },
  solar_sail_array: { name: "太阳帆阵列", item: "太阳帆" },
  carrier_rocket_fleet: { name: "运载火箭舰队", item: "小型运载火箭" },
  antimatter_exchange: { name: "反物质能源交换", item: "反物质燃料棒" },
} as const;

export interface NativeGalaxyWorkspaceProps {
  open: boolean;
  focusTab?: "ranking" | "speedrun" | "cloud" | "account" | null;
  accountState: AccountState;
  frame: NativeGalaxyWorkspaceFrame | null;
  latestIdentity: NativeCampaignGalaxyWorkspaceIdentity | null;
  status: NativeCampaignGalaxyWorkspaceReadStatus;
  onClose: () => void;
  onUpdateProfile: (changes: AccountProfileChanges) => void;
  onUpdateCloudBinding: (
    expectedAccountId: string,
    cloud: { id: string; email: string } | null,
  ) => boolean;
  onCreateAccount: (displayName: string) => void;
  onSwitchAccount: (accountId: string) => void;
  exportPending?: boolean;
  onExportIntent?: (intent: NativeProjectedGalacticExportIntent) => boolean;
}

function compactDecimal(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, "");
  if (normalized.length <= 15) {
    try { return BigInt(normalized).toLocaleString("zh-CN"); } catch { return normalized; }
  }
  return `${normalized.slice(0, 6)[0]}.${normalized.slice(1, 6)}E${normalized.length - 1}`;
}

function exportProgressPercent(delivered: string, target: string): number {
  try {
    const denominator = BigInt(target);
    if (denominator <= 0n) return 0;
    const basisPoints = BigInt(delivered) * 10_000n / denominator;
    return Math.min(100, Number(basisPoints) / 100);
  } catch {
    return 0;
  }
}

export function NativeGalaxyWorkspace({
  open,
  focusTab,
  accountState,
  frame: candidateFrame,
  latestIdentity,
  status,
  onClose,
  onUpdateProfile,
  onUpdateCloudBinding,
  onCreateAccount,
  onSwitchAccount,
  exportPending = false,
  onExportIntent,
}: NativeGalaxyWorkspaceProps) {
  const [tab, setTab] = useState<NativeGalaxyTab>("overview");
  const [nameDraft, setNameDraft] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [cloudSession, setCloudSession] = useState<CloudSession>({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null });
  const [cloudIdentifier, setCloudIdentifier] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [cloudRetryToken, setCloudRetryToken] = useState<string | null>(null);
  const [cloudProgress, setCloudProgress] = useState<DesktopNativePlayerAuthorityCloudProgress | null>(null);
  const [dispatchDrafts, setDispatchDrafts] = useState<Record<string, string>>({});
  const [pendingDispatch, setPendingDispatch] = useState<Readonly<{
    projectId: keyof typeof EXPORT_LABELS;
    requestedAmount: string;
    revision: number;
  }> | null>(null);
  const account = getActiveAccount(accountState);
  const accounts = Object.values(accountState.accounts).slice(0, 32);

  useEffect(() => {
    if (!open) return;
    if (focusTab === "cloud") setTab("cloud");
    else if (focusTab === "account") setTab("account");
    else if (focusTab) setTab("overview");
  }, [focusTab, open]);
  useEffect(() => setNameDraft(account.profile.displayName), [account.profile.displayName, account.profile.id]);
  const frameMatchesScope = Boolean(candidateFrame && latestIdentity &&
    candidateFrame.sessionId === latestIdentity.sessionId &&
    candidateFrame.runId === latestIdentity.runId &&
    candidateFrame.registryFingerprint === latestIdentity.registryFingerprint &&
    candidateFrame.revision <= latestIdentity.revision);
  const frame = frameMatchesScope && candidateFrame && latestIdentity &&
      (candidateFrame.revision === latestIdentity.revision
        ? status === "ready"
        : status === "loading" || status === "unavailable")
    ? candidateFrame
    : null;
  const projection = frame?.projection ?? null;
  const exactFrame = Boolean(frame && latestIdentity && status === "ready" &&
    frame.revision === latestIdentity.revision);
  const exportCommandEnabled = Boolean(exactFrame && !exportPending && onExportIntent &&
    projection?.galacticExports.unlocked);
  useEffect(() => {
    setPendingDispatch(null);
  }, [
    exportPending,
    frame?.revision,
    frame?.runId,
    frame?.sessionId,
    latestIdentity?.revision,
    latestIdentity?.runId,
    latestIdentity?.sessionId,
    open,
    status,
  ]);
  useEffect(() => {
    setDispatchDrafts({});
  }, [frame?.runId, frame?.sessionId, open]);
  useEffect(() => {
    if (!open || !projection) return;
    let active = true;
    setCloudSession((current) => ({ ...current, status: "checking" }));
    void resumeCloudSession(projection.game.mode).then((session) => { if (active) setCloudSession(session); });
    return () => { active = false; };
  }, [open, projection?.game.mode]);
  useEffect(() => {
    if (!open) return;
    const bridge = getDesktopBridge();
    return bridge?.onNativePlayerAuthorityCloudProgress?.((progress) => {
      if (progress && typeof progress === "object" && typeof progress.token === "string") {
        setCloudProgress(progress);
      }
    });
  }, [open]);

  const metrics = useMemo(() => projection ? [
    { label: "累计生产", value: compactDecimal(projection.production.totalProduced), icon: <Database size={18} /> },
    { label: "宇宙矩阵", value: compactDecimal(projection.production.universeMatrixProduced), icon: <Activity size={18} /> },
    { label: "当前发电", value: `${compactDecimal(projection.production.generationKw)} kW`, icon: <Zap size={18} /> },
    { label: "每分钟吞吐", value: compactDecimal(projection.production.throughputPerMinute), icon: <Factory size={18} /> },
    { label: "戴森功率", value: `${compactDecimal(projection.dyson.powerKw)} kW`, icon: <Orbit size={18} /> },
    { label: "银河评分", value: compactDecimal(projection.progress.galacticScore), icon: <Globe2 size={18} /> },
  ] : [], [projection]);

  if (!open) return null;
  if (!projection) {
    return <WorkspaceFrame className="galaxy-workspace" ariaLabel="原生银河账户" onRequestClose={onClose}
      data-native-galaxy-status={status}>
      <header className="galaxy-header">
        <div className="galaxy-title"><i><Globe2 size={20} /></i><div><span>RUST 权威</span><strong>银河网络</strong></div></div>
        <button className="galaxy-close" type="button" onClick={onClose} aria-label="关闭银河网络"><X size={18} /></button>
      </header>
      <div className="workspace-loading" role={status === "empty" || status === "loading" ? "status" : "alert"}>
        {status === "empty" || status === "loading" ? <i /> : <ShieldAlert size={22} />}
        <span>{status === "empty" || status === "loading"
          ? "正在读取 Rust 权威银河摘要…"
          : "银河投影未通过当前 revision、run 或目录校验；银河页已安全关闭。"}</span>
      </div>
    </WorkspaceFrame>;
  }

  const submitLogin = async () => {
    if (cloudBusy || !cloudIdentifier.trim() || !cloudPassword) return;
    const expectedAccountId = account.profile.id;
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const session = await loginCloudAccount(cloudIdentifier.trim(), cloudPassword);
      setCloudSession(session);
      const bindingUpdated = session.user
        ? onUpdateCloudBinding(expectedAccountId, { id: session.user.id, email: session.user.email })
        : false;
      setCloudPassword("");
      setCloudMessage(session.user && !bindingUpdated
        ? "云账号已登录，但本地身份在请求期间切换；未修改任何本地身份绑定。"
        : "云身份已绑定；主存档恢复、导入和覆盖仍保持禁用。");
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "云账号登录失败");
    } finally {
      setCloudBusy(false);
    }
  };
  const submitLogout = async () => {
    if (cloudBusy) return;
    const expectedAccountId = account.profile.id;
    setCloudBusy(true);
    try {
      await logoutCloudAccount();
      const bindingUpdated = onUpdateCloudBinding(expectedAccountId, null);
      setCloudSession({ status: "anonymous", user: null, cloudSave: null, mode: projection.game.mode, mailAvailable: cloudSession.mailAvailable, message: null });
      setCloudMessage(bindingUpdated
        ? "已退出并解除当前本地身份的云绑定。"
        : "云账号已退出，但本地身份在请求期间切换；未修改任何本地身份绑定。");
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "退出云账号失败");
    } finally {
      setCloudBusy(false);
    }
  };
  const uploadNativeMainSave = async () => {
    if (cloudBusy || !exactFrame || projection.game.mode !== "normal") return;
    const bridge = getDesktopBridge();
    const token = getCloudToken();
    if (!bridge?.uploadNativePlayerAuthorityCloudSave || !token) {
      setCloudMessage("当前桌面壳或云凭据不支持原生主档上传；未发送任何存档数据。");
      return;
    }
    setCloudBusy(true);
    setCloudMessage(null);
    setCloudProgress(null);
    try {
      const result = await bridge.uploadNativePlayerAuthorityCloudSave({
        authorization: `Bearer ${token}`,
        expectedRevision: cloudSession.cloudSave?.revision ?? 0,
        ...(cloudRetryToken ? { retryToken: cloudRetryToken } : {}),
      });
      if (result.status === "confirmed") {
        setCloudRetryToken(null);
        setCloudMessage(`Rust 主档已流式上传到云端修订 ${result.cloudSave?.revision ?? "已确认"}；renderer 从未接收存档正文。`);
        setCloudSession(await resumeCloudSession("normal"));
      } else if (result.status === "unknown") {
        setCloudRetryToken(result.token);
        setCloudMessage("网络结果暂时无法确认。原生导出和同一个幂等令牌已保留；请手动点击“重试同一份”，程序不会重新生成或自动覆盖云端。");
      } else {
        setCloudRetryToken(null);
        setCloudMessage(`云端明确拒绝本次上传${result.httpStatus ? `（HTTP ${result.httpStatus}）` : ""}；本地权威检查点未改变。`);
      }
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "原生主档上传失败；本地权威检查点未改变");
    } finally {
      setCloudBusy(false);
    }
  };

  const cloudBoundToActiveAccount = cloudSession.status === "authenticated" &&
    cloudSession.user !== null && account.profile.cloudUserId === cloudSession.user.id;
  const submitExportIntent = (intent: NativeProjectedGalacticExportIntent): boolean => {
    if (!exportCommandEnabled || !onExportIntent) return false;
    return onExportIntent(intent);
  };
  const dispatchConfirmationCurrent = Boolean(pendingDispatch && exactFrame &&
    pendingDispatch.revision === projection.revision && !exportPending &&
    projection.galacticExports.inputMode === "legacy-network" &&
    projection.galacticExports.projects.some((row) => row.id === pendingDispatch.projectId));
  const confirmManualDispatch = () => {
    if (!pendingDispatch || !dispatchConfirmationCurrent) {
      setPendingDispatch(null);
      return;
    }
    const intent: NativeProjectedGalacticExportIntent = {
      type: "manual-dispatch",
      projectId: pendingDispatch.projectId,
      requestedAmount: pendingDispatch.requestedAmount,
    };
    setPendingDispatch(null);
    submitExportIntent(intent);
  };

  return <WorkspaceFrame className="galaxy-workspace native-galaxy-workspace" ariaLabel="原生银河账户" onRequestClose={onClose}
    data-native-galaxy-status={exactFrame ? "ready" : status}
    data-native-galaxy-revision={projection.revision}
    data-native-galaxy-display-stale={exactFrame ? undefined : "true"}>
    <header className="galaxy-header">
      <div className="galaxy-title"><i><Globe2 size={20} /></i><div><span>RUST 权威 · REV {projection.revision}</span><strong>银河网络</strong></div></div>
      <div className="galaxy-node-state"><i /><span><strong>原生摘要已校验</strong><small>存档结构 v{projection.stateVersion}</small></span></div>
      <div className="galaxy-active-account"><span className="galaxy-avatar galaxy-avatar--small">{account.profile.avatar}</span><span><small>当前本地身份</small><strong>{account.profile.displayName}</strong></span></div>
      <button className="galaxy-close" type="button" onClick={onClose} aria-label="关闭银河网络"><X size={18} /></button>
    </header>
    {!exactFrame && latestIdentity
      ? <p role="status" className="operations-notice">{status === "unavailable"
        ? `Rust revision ${latestIdentity.revision} 暂不可用`
        : `正在读取 Rust revision ${latestIdentity.revision}`}；当前保持显示已验证的 revision {projection.revision}。</p>
      : null}
    <nav className="galaxy-tabs" aria-label="银河页面">
      <button className={tab === "overview" ? "active" : ""} type="button" onClick={() => setTab("overview")}><Activity size={14} />原生摘要</button>
      <button className={tab === "exports" ? "active" : ""} type="button" onClick={() => setTab("exports")}><Factory size={14} />银河出口</button>
      <button className={tab === "account" ? "active" : ""} type="button" onClick={() => setTab("account")}><UserRound size={14} />本地身份</button>
      <button className={tab === "cloud" ? "active" : ""} type="button" onClick={() => setTab("cloud")}><Cloud size={14} />云绑定</button>
      <span><ShieldCheck size={12} />账户域与游戏域严格分层</span>
    </nav>
    {tab === "overview" ? <div className="galaxy-profile-editor">
      <header><div><Activity size={18} /><span><small>{projection.game.mode === "normal" ? "普通模式" : "速通模式"}</small><strong>Rust 游戏摘要</strong></span></div><span>运行 {compactDecimal(projection.game.elapsedSeconds)} 秒</span></header>
      <section className="galaxy-ledger-section"><header><span><Database size={14} />当前权威 revision</span><small>不含库存、实体、线路或隐藏余额</small></header><div>{metrics.map((metric) => <article key={metric.label}>{metric.icon}<span>{metric.label}<strong>{metric.value}</strong></span></article>)}</div></section>
      <div className="galaxy-account-notice"><ShieldCheck size={18} /><span><strong>有界游戏摘要</strong><small>战役 {projection.progress.campaignCompleted}/{projection.progress.campaignTotal} · 科技 {projection.progress.researchCompleted} · 星系 {projection.progress.exploredSystems} · 行星 {projection.progress.colonizedPlanets}</small></span></div>
    </div> : null}
    {tab === "exports" ? <div className="galaxy-profile-editor native-galactic-export-workspace" data-native-galactic-export="semantic-intent-v1">
      <header><div><Factory size={18} /><span><small>{projection.galacticExports.inputMode === "building" ? "实体建筑交付" : "兼容网络调度"}</small><strong>Rust 银河出口</strong></span></div><span>{projection.galacticExports.exporters.running}/{projection.galacticExports.exporters.total} 座运行</span></header>
      <section className="galaxy-ledger-section"><header><span><Database size={14} />守恒出口总账</span><small>只读计数；库存、奖励与等级由 Rust 结算</small></header><div>
        <article><Database size={18} /><span>银河信用<strong>{compactDecimal(projection.galacticExports.galacticCredits)}</strong></span></article>
        <article><Globe2 size={18} /><span>银河评分<strong>{compactDecimal(projection.galacticExports.galacticScore)}</strong></span></article>
        <article><Factory size={18} /><span>累计出口<strong>{compactDecimal(projection.galacticExports.totalExported)}</strong></span></article>
        <article><Activity size={18} /><span>最近每分钟<strong>{compactDecimal(projection.galacticExports.exportedLastMinute)}</strong></span></article>
      </div></section>
      {!projection.galacticExports.unlocked ? <div className="galaxy-account-notice"><LockKeyhole size={18} /><span><strong>尚未解锁宇宙矩阵科技</strong><small>出口命令保持关闭，历史数据不会被修改。</small></span></div> : null}
      {projection.galacticExports.inputMode === "legacy-network" ? <section className="native-inspector-safe-actions">
        <strong>兼容网络调度</strong>
        <p>开关与倍率只提交目标值；手动交付只提交请求上限，Rust 会保留项目储备并按当前库存实际扣除。</p>
        <div className="native-inspector-stack-actions" role="group" aria-label="银河出口自动调度">
          <button type="button" disabled={!exportCommandEnabled} aria-pressed={projection.galacticExports.autoDispatch} onClick={() => submitExportIntent({ type: "set-auto-dispatch", enabled: !projection.galacticExports.autoDispatch })}>{projection.galacticExports.autoDispatch ? "关闭自动调度" : "开启自动调度"}</button>
          {([0.25, 0.5, 1] as const).map((throttle) => <button type="button" key={throttle} disabled={!exportCommandEnabled || projection.galacticExports.dispatchThrottle === throttle} aria-pressed={projection.galacticExports.dispatchThrottle === throttle} onClick={() => submitExportIntent({ type: "set-dispatch-throttle", throttle })}>{throttle * 100}%</button>)}
        </div>
      </section> : <div className="galaxy-account-notice"><ShieldCheck size={18} /><span><strong>实体出口模式</strong><small>物资由超大型出口建筑的四个输入口真实消耗；建筑暂停开关位于同 revision 的原生建筑检查器。</small></span></div>}
      <section className="station-accepted-contracts native-galactic-export-projects"><header><strong>四项固定出口工程</strong><small>项目目录和物料绑定均由边界逐项校验</small></header>
        {projection.galacticExports.projects.map((project) => {
          const labels = EXPORT_LABELS[project.id];
          const remaining = (() => {
            try { return (BigInt(project.target) - BigInt(project.delivered) > 0n ? BigInt(project.target) - BigInt(project.delivered) : 1n).toString(); } catch { return "1"; }
          })();
          const draft = dispatchDrafts[project.id] ?? remaining;
          return <article key={project.id}>
            <header><div><span>{labels.item} · 储备 {compactDecimal(project.reserve)}</span><strong>{labels.name}</strong></div><b>Lv.{compactDecimal(project.level)}</b></header>
            <div className="station-contract-requirement"><span>本级进度<small>{compactDecimal(project.delivered)} / {compactDecimal(project.target)} · 累计 {compactDecimal(project.totalDelivered)}</small></span><i><b style={{ width: `${exportProgressPercent(project.delivered, project.target)}%` }} /></i></div>
            <footer>
              <div className="native-inspector-stack-actions" role="group" aria-label={`${labels.name}优先级`}>
                {([1, 2, 3] as const).map((priority) => <button type="button" key={priority} disabled={!exportCommandEnabled || project.priority === priority} aria-pressed={project.priority === priority} onClick={() => submitExportIntent({ type: "set-project-priority", projectId: project.id, priority })}>{priority === 3 ? "高" : priority === 2 ? "中" : "低"}</button>)}
              </div>
              {projection.galacticExports.inputMode === "legacy-network" ? <>
                <button type="button" disabled={!exportCommandEnabled} aria-pressed={project.enabled} onClick={() => submitExportIntent({ type: "set-project-enabled", projectId: project.id, enabled: !project.enabled })}>{project.enabled ? "停止自动出口" : "加入自动出口"}</button>
                <input aria-label={`${labels.name}手动交付数量`} inputMode="numeric" maxLength={16} value={draft} disabled={!exportCommandEnabled} onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDispatchDrafts((current) => ({ ...current, [project.id]: value }));
                }} />
                <button type="button" disabled={!exportCommandEnabled || !/^[1-9][0-9]{0,15}$/.test(draft)} onClick={() => setPendingDispatch({ projectId: project.id, requestedAmount: draft, revision: projection.revision })}>确认手动交付</button>
              </> : null}
            </footer>
          </article>;
        })}
      </section>
    </div> : null}
    {tab === "account" ? <div className="galaxy-account-view">
      <aside className="galaxy-account-list"><header><span><UserRound size={14} />本地身份</span><strong>{accounts.length}/32</strong></header><div>{accounts.map((record) => <button className={record.profile.id === accountState.activeAccountId ? "active" : ""} type="button" key={record.profile.id} onClick={() => onSwitchAccount(record.profile.id)}><span className="galaxy-avatar galaxy-avatar--small">{record.profile.avatar}</span><span><strong>{record.profile.displayName}</strong><small>{record.profile.cloudEmail ?? "未绑定云账号"}</small></span>{record.profile.id === accountState.activeAccountId ? <ShieldCheck size={13} /> : null}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); const value = newAccountName.trim(); if (!value || accounts.length >= 32) return; onCreateAccount(value); setNewAccountName(""); }}><input value={newAccountName} maxLength={24} onChange={(event) => setNewAccountName(event.currentTarget.value)} placeholder="新身份名称" /><button type="submit" disabled={accounts.length >= 32} aria-label="新建本地身份"><Plus size={15} /></button></form></aside>
      <main className="galaxy-profile-editor"><header><div><UserRound size={18} /><span><small>账户域资料</small><strong>{account.profile.displayName}</strong></span></div><span><ShieldCheck size={13} />不读取游戏状态</span></header><form onSubmit={(event) => { event.preventDefault(); onUpdateProfile({ displayName: nameDraft }); }}>
        <label className="galaxy-name-field"><span>显示名称</span><div><input value={nameDraft} maxLength={24} onChange={(event) => setNameDraft(event.currentTarget.value)} /><button type="submit">保存资料</button></div><small>只更新本地账户资料，不写 Rust 游戏。</small></label>
        <fieldset className="galaxy-avatar-picker"><legend>头像</legend><div>{ACCOUNT_AVATARS.map((avatar) => <button className={avatar === account.profile.avatar ? "active" : ""} type="button" key={avatar} onClick={() => onUpdateProfile({ avatar })}><span>{avatar}</span></button>)}</div></fieldset>
        <label className="galaxy-privacy-setting"><span className="galaxy-privacy-icon">{account.profile.privacy === "private" ? <EyeOff size={16} /> : <Eye size={16} />}</span><span><strong>公开账户资料</strong><small>只控制账户隐私偏好，不提交游戏成绩。</small></span><input type="checkbox" checked={account.profile.privacy === "public"} onChange={(event) => onUpdateProfile({ privacy: event.currentTarget.checked ? "public" : "private" })} /><i><b /></i></label>
      </form></main>
    </div> : null}
    {tab === "cloud" ? <div className="galaxy-cloud-view"><section className="galaxy-cloud-status"><header><i>{cloudSession.status === "offline" ? <CloudOff size={20} /> : <Cloud size={20} />}</i><span><small>账户域会话</small><strong>{cloudSession.user?.displayName ?? (cloudSession.status === "checking" ? "正在检查云身份" : "未登录云账号")}</strong></span><em className={`cloud-state cloud-state--${cloudSession.status}`}>{cloudSession.status}</em></header>
      {cloudSession.status === "authenticated" && cloudSession.user ? <div className="galaxy-cloud-identity"><span className="galaxy-avatar">{account.profile.avatar}</span><span><strong>{cloudSession.user.email}</strong><small>{cloudBoundToActiveAccount ? "已绑定到当前本地身份；这里只维护登录与绑定关系。" : "云会话已登录，但未绑定当前本地身份。"}</small></span><button type="button" disabled={cloudBusy} onClick={() => void submitLogout()}><LogOut size={14} />{cloudBoundToActiveAccount ? "退出并解绑" : "退出云账号"}</button></div> : <form className="galaxy-cloud-auth" onSubmit={(event) => { event.preventDefault(); void submitLogin(); }}><label><span>用户名或邮箱</span><input value={cloudIdentifier} autoComplete="username" onChange={(event) => setCloudIdentifier(event.currentTarget.value)} /></label><label><span>密码</span><input type="password" value={cloudPassword} autoComplete="current-password" onChange={(event) => setCloudPassword(event.currentTarget.value)} /></label><button type="submit" disabled={cloudBusy || cloudSession.status === "checking"}><LogIn size={14} />登录并绑定</button></form>}
      {cloudMessage || cloudSession.message ? <p className="galaxy-cloud-message">{cloudMessage ?? cloudSession.message}</p> : null}</section>
      <div className="galaxy-cloud-policy"><LockKeyhole size={20} /><span><strong>云端恢复仍保持关闭</strong><small>Rust 玩家权威运行时，下载覆盖、冲突恢复和导入仍需先安全关闭当前 authority lineage；上传只读取 main 拥有的只读导出流，不读取旧 JavaScript 镜像。</small></span></div>
      {cloudSession.status === "authenticated" && cloudSession.user && projection.game.mode === "normal" ? <section className="galaxy-cloud-status" data-native-cloud-upload="main-owned-stream-v1">
        <header><i><Cloud size={20} /></i><span><small>普通模式主云档</small><strong>{cloudSession.cloudSave ? `当前云端修订 ${cloudSession.cloudSave.revision}` : "尚未上传"}</strong></span></header>
        {cloudProgress?.stage === "uploading" ? <p className="galaxy-cloud-message">正在由主进程上传：{Math.min(100, Math.floor(cloudProgress.sentBytes * 100 / Math.max(1, cloudProgress.totalBytes)))}%</p> : null}
        <button type="button" disabled={cloudBusy || !exactFrame} onClick={() => void uploadNativeMainSave()}><Cloud size={14} />{cloudRetryToken ? "重试同一份" : "流式上传 Rust 主档"}</button>
      </section> : null}
    </div> : null}
    {dispatchConfirmationCurrent && pendingDispatch ? <AccessibleDialog
      open
      title="确认银河物资交付"
      ariaLabel="确认银河物资交付"
      role="alertdialog"
      riskPolicy="explicit"
      className="native-galactic-export-confirm"
      onRequestClose={() => setPendingDispatch(null)}
    >
      <p>请求向“{EXPORT_LABELS[pendingDispatch.projectId].name}”最多交付 <strong>{compactDecimal(pendingDispatch.requestedAmount)}</strong> 个{EXPORT_LABELS[pendingDispatch.projectId].item}。</p>
      <p>该物资会被真实消耗。Rust 会从当前权威库存重新计算可用量并保留项目储备，界面不会填写实际扣料、奖励或等级结果。</p>
      <footer><button type="button" onClick={() => setPendingDispatch(null)}>取消</button><button className="danger" type="button" onClick={confirmManualDispatch}>由 Rust 守恒交付</button></footer>
    </AccessibleDialog> : null}
  </WorkspaceFrame>;
}
