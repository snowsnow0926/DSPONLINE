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
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest,
  DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
} from "../desktop";
import { ACCOUNT_AVATARS, getActiveAccount, type AccountProfileChanges, type AccountState } from "../game/account";
import { loginCloudAccount, logoutCloudAccount, resumeCloudSession, type CloudSession } from "../game/cloud";
import { WorkspaceFrame } from "./WorkspaceFrame";

type NativeGalaxyTab = "overview" | "account" | "cloud";
type NativeGalaxyStatus =
  | { phase: "loading" }
  | { phase: "ready"; projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult }
  | { phase: "unavailable"; message: string };

export interface NativeGalaxyWorkspaceProps {
  open: boolean;
  focusTab?: "ranking" | "speedrun" | "cloud" | "account" | null;
  accountState: AccountState;
  identity: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest | null;
  fetchProjection: ((request: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest) => Promise<DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult>) | null;
  onClose: () => void;
  onUpdateProfile: (changes: AccountProfileChanges) => void;
  onUpdateCloudBinding: (
    expectedAccountId: string,
    cloud: { id: string; email: string } | null,
  ) => boolean;
  onCreateAccount: (displayName: string) => void;
  onSwitchAccount: (accountId: string) => void;
}

function identityMatches(
  projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  identity: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest,
): boolean {
  return projection.sessionId === identity.sessionId && projection.runId === identity.runId &&
    projection.revision === identity.expectedRevision &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint &&
    projection.truncated === false;
}

function scopeMatches(
  projection: DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult,
  identity: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest,
): boolean {
  return projection.sessionId === identity.sessionId && projection.runId === identity.runId &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint && projection.truncated === false;
}

function galaxyIdentityKey(identity: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest | null): string {
  return identity
    ? `${identity.sessionId}\u0000${identity.runId}\u0000${identity.expectedRevision}\u0000${identity.expectedRegistryFingerprint}`
    : "missing";
}

function compactDecimal(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, "");
  if (normalized.length <= 15) {
    try { return BigInt(normalized).toLocaleString("zh-CN"); } catch { return normalized; }
  }
  return `${normalized.slice(0, 6)[0]}.${normalized.slice(1, 6)}E${normalized.length - 1}`;
}

function projectionUnavailable(identity: NativeGalaxyWorkspaceProps["identity"], fetchProjection: NativeGalaxyWorkspaceProps["fetchProjection"]): string {
  if (!identity) return "原生玩家权威 lineage 尚未就绪；银河页不会读取旧 Web 主档。";
  if (!fetchProjection) return "当前 Windows Host 不支持银河账户薄投影；银河页已安全关闭。";
  return "银河投影未通过当前 revision、run 或目录校验；银河页已安全关闭。";
}

export function NativeGalaxyWorkspace({
  open,
  focusTab,
  accountState,
  identity,
  fetchProjection,
  onClose,
  onUpdateProfile,
  onUpdateCloudBinding,
  onCreateAccount,
  onSwitchAccount,
}: NativeGalaxyWorkspaceProps) {
  const [tab, setTab] = useState<NativeGalaxyTab>("overview");
  const [status, setStatus] = useState<NativeGalaxyStatus>({ phase: "loading" });
  const [nameDraft, setNameDraft] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [cloudSession, setCloudSession] = useState<CloudSession>({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null });
  const [cloudIdentifier, setCloudIdentifier] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const account = getActiveAccount(accountState);
  const accounts = Object.values(accountState.accounts).slice(0, 32);
  const currentIdentityRef = useRef(identity);
  currentIdentityRef.current = identity;
  const identityKey = galaxyIdentityKey(identity);

  useEffect(() => {
    if (!open) return;
    if (focusTab === "cloud") setTab("cloud");
    else if (focusTab === "account") setTab("account");
    else if (focusTab) setTab("overview");
  }, [focusTab, open]);
  useEffect(() => setNameDraft(account.profile.displayName), [account.profile.displayName, account.profile.id]);
  useEffect(() => {
    if (!open) return;
    if (!identity || !fetchProjection) {
      setStatus({ phase: "unavailable", message: projectionUnavailable(identity, fetchProjection) });
      return;
    }
    setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, identity)
      ? current
      : { phase: "loading" });
    void fetchProjection(identity).then((projection) => {
      const currentIdentity = currentIdentityRef.current;
      if (!identityMatches(projection, identity)) {
        if (!currentIdentity || galaxyIdentityKey(currentIdentity) !== galaxyIdentityKey(identity)) return;
        setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity)
          ? current
          : { phase: "unavailable", message: projectionUnavailable(identity, fetchProjection) });
        return;
      }
      if (!currentIdentity || !scopeMatches(projection, currentIdentity) || projection.revision > currentIdentity.expectedRevision) return;
      setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity) &&
        current.projection.revision >= projection.revision
        ? current
        : { phase: "ready", projection });
    }).catch(() => {
      const currentIdentity = currentIdentityRef.current;
      if (!currentIdentity || galaxyIdentityKey(currentIdentity) !== galaxyIdentityKey(identity)) return;
      setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity)
        ? current
        : { phase: "unavailable", message: projectionUnavailable(identity, fetchProjection) });
    });
  }, [fetchProjection, identityKey, open]);

  const projection = status.phase === "ready" && identity && scopeMatches(status.projection, identity)
    ? status.projection
    : null;
  useEffect(() => {
    if (!open || !projection) return;
    let active = true;
    setCloudSession((current) => ({ ...current, status: "checking" }));
    void resumeCloudSession(projection.game.mode).then((session) => { if (active) setCloudSession(session); });
    return () => { active = false; };
  }, [open, projection?.game.mode]);

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
    return <WorkspaceFrame className="galaxy-workspace" ariaLabel="原生银河账户" onRequestClose={onClose}>
      <header className="galaxy-header">
        <div className="galaxy-title"><i><Globe2 size={20} /></i><div><span>RUST 权威</span><strong>银河网络</strong></div></div>
        <button className="galaxy-close" type="button" onClick={onClose} aria-label="关闭银河网络"><X size={18} /></button>
      </header>
      <div className="workspace-loading" role={status.phase === "loading" ? "status" : "alert"}>
        {status.phase === "loading" ? <i /> : <ShieldAlert size={22} />}
        <span>{status.phase === "loading" ? "正在读取 Rust 权威银河摘要…" : status.phase === "unavailable" ? status.message : "银河投影已失效"}</span>
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

  const cloudBoundToActiveAccount = cloudSession.status === "authenticated" &&
    cloudSession.user !== null && account.profile.cloudUserId === cloudSession.user.id;

  return <WorkspaceFrame className="galaxy-workspace native-galaxy-workspace" ariaLabel="原生银河账户" onRequestClose={onClose}>
    <header className="galaxy-header">
      <div className="galaxy-title"><i><Globe2 size={20} /></i><div><span>RUST 权威 · REV {projection.revision}</span><strong>银河网络</strong></div></div>
      <div className="galaxy-node-state"><i /><span><strong>原生摘要已校验</strong><small>存档结构 v{projection.stateVersion}</small></span></div>
      <div className="galaxy-active-account"><span className="galaxy-avatar galaxy-avatar--small">{account.profile.avatar}</span><span><small>当前本地身份</small><strong>{account.profile.displayName}</strong></span></div>
      <button className="galaxy-close" type="button" onClick={onClose} aria-label="关闭银河网络"><X size={18} /></button>
    </header>
    {identity && projection.revision !== identity.expectedRevision
      ? <p role="status" className="operations-notice">正在读取 Rust revision {identity.expectedRevision}；当前保持显示已验证的 revision {projection.revision}。</p>
      : null}
    <nav className="galaxy-tabs" aria-label="银河页面">
      <button className={tab === "overview" ? "active" : ""} type="button" onClick={() => setTab("overview")}><Activity size={14} />原生摘要</button>
      <button className={tab === "account" ? "active" : ""} type="button" onClick={() => setTab("account")}><UserRound size={14} />本地身份</button>
      <button className={tab === "cloud" ? "active" : ""} type="button" onClick={() => setTab("cloud")}><Cloud size={14} />云绑定</button>
      <span><ShieldCheck size={12} />账户域与游戏域严格分层</span>
    </nav>
    {tab === "overview" ? <div className="galaxy-profile-editor">
      <header><div><Activity size={18} /><span><small>{projection.game.mode === "normal" ? "普通模式" : "速通模式"}</small><strong>Rust 游戏摘要</strong></span></div><span>运行 {compactDecimal(projection.game.elapsedSeconds)} 秒</span></header>
      <section className="galaxy-ledger-section"><header><span><Database size={14} />当前权威 revision</span><small>不含库存、实体、线路或隐藏余额</small></header><div>{metrics.map((metric) => <article key={metric.label}>{metric.icon}<span>{metric.label}<strong>{metric.value}</strong></span></article>)}</div></section>
      <div className="galaxy-account-notice"><ShieldCheck size={18} /><span><strong>有界游戏摘要</strong><small>战役 {projection.progress.campaignCompleted}/{projection.progress.campaignTotal} · 科技 {projection.progress.researchCompleted} · 星系 {projection.progress.exploredSystems} · 行星 {projection.progress.colonizedPlanets}</small></span></div>
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
      <div className="galaxy-cloud-policy"><LockKeyhole size={20} /><span><strong>主档写入边界保持关闭</strong><small>Rust 玩家权威运行时，恢复云存档、导入存档和覆盖当前主档均明确禁用。请先通过受控持久化切换流程退出当前权威会话；本页面不会绕过该边界。</small></span></div>
    </div> : null}
  </WorkspaceFrame>;
}
