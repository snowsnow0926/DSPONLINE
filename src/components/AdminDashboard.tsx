import {
  Activity,
  Clock3,
  Cloud,
  Database,
  Gauge,
  KeyRound,
  LogOut,
  MousePointerClick,
  Radio,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import "../admin.css";
import { StableTextInput } from "./CompositionSafeInput";

interface AnalyticsDay {
  day: string;
  uniqueVisitors: number;
  sessions: number;
  pageViews: number;
  gameStarts: number;
  activeSeconds: number;
  events: Record<string, number>;
  clients: Record<string, number>;
  sources: Record<string, number>;
}

interface OperationalStatus {
  configured: boolean;
  ok: boolean;
  state: "disabled" | "pending" | "ready" | "failed" | "unreadable";
  completedAt?: number | null;
  failedAt?: number | null;
  transported?: boolean;
  transport?: string | null;
}

interface AdminMetrics {
  generatedAt: number;
  timeZone: string;
  schemaVersion: number;
  uptimeSeconds: number;
  storage: "sqlite" | "json";
  runtime: {
    requests: number;
    errors: number;
    rateLimited: number;
    cloudConflicts: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    slowRequests?: number;
    maxRequestMs?: number;
    writeQueueDepth?: number;
    maxWriteQueueDepth?: number;
    slowWrites?: number;
    lastWriteDurationMs?: number;
    loginSecurity?: { failures: number; activeBuckets: number; activeLocks: number };
  };
  accounts: { users: number; activeSessions: number; cloudSaves: number; submissions: number };
  leaderboardReviews?: { pending: number };
  players: {
    total: number;
    today: number;
    online: number;
    onlineWindowSeconds: number;
    estimates?: {
      days: number;
      estimatedPlayersDaySum: number;
      latest: { day: string; playersEstimate: number; observedPlayers: number; status: string; confidence: string } | null;
      daily: Array<{ day: string; playersEstimate: number; observedPlayers: number; status: string; confidence: string }>;
    };
  };
  analytics: {
    today: string;
    totalVisitors: number;
    retainedSessions: number;
    range: { days: number; uniqueVisitors: number; sessions: number; pageViews: number; gameStarts: number; activeSeconds: number };
    lifetime: { uniqueVisitors: number; sessions: number; pageViews: number; gameStarts: number; activeSeconds: number };
    events: Array<{ name: string; count: number }>;
    performance?: {
      pageLoad: { samples: number; fast: number; acceptable: number; slow: number; verySlow: number; p75Band: string };
      lcp: { samples: number; good: number; needsImprovement: number; poor: number; p75Band: string };
      transfer: { samples: number; light: number; medium: number; heavy: number; p75Band: string };
    };
    daily: AnalyticsDay[];
  };
  reports: { feedback: number; clientErrors: number };
  audit?: { entries: number; recent: Array<{ action: string; occurredAt: number; clientType: string }> };
  backups: {
    configured: boolean;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    state?: "disabled" | "idle" | "running" | "ready" | "failed";
    startedAt?: number | null;
    durationMs?: number | null;
    dailyWindow?: string | null;
    offsite?: OperationalStatus;
    restoreDrill?: OperationalStatus;
  };
  infrastructure?: {
    configured: boolean;
    ok: boolean;
    state: string;
    checkedAt: number | null;
    endpoints: Array<{ url: string; ok: boolean; status: number; latencyMs: number | null; contentEncoding: string | null }>;
    disk: { ok: boolean; freeBytes: number | null; totalBytes: number | null; freeRatio: number | null } | null;
    tls: { configured: boolean; ok: boolean; expiresAt: number | null; daysRemaining: number | null } | null;
  };
  governance?: {
    sqlite: null | {
      layoutVersion: number;
      databaseBytes: number;
      walBytes: number;
      appStateBytes: number;
      cloudPayloadBytes: number;
      cloudPayloadRows: number;
      averageRevisionsPerAccount: number;
    };
    historyPrune: { runs: number; payloadsRemoved: number; metadataRemoved: number; lastRunAt: number | null };
    disk: { warning80Percent: boolean; protection90Percent: boolean };
  };
}

type AdminAccountAction = "revoke-sessions" | "disable-login" | "enable-login" | "restrict-leaderboard" | "restore-leaderboard" | "approve-leaderboard-review" | "delete-account";

interface LeaderboardReview {
  accountId: string;
  username: string | null;
  displayName: string | null;
  status: "pending" | "approved";
  reasonCode: string;
  source: string;
  detectedRevision: number;
  detectedChecksumPrefix: string | null;
  firstDetectedAt: number;
  lastDetectedAt: number;
  occurrences: number;
  findings: Array<{ code: string; field?: string; severity: string }>;
  fingerprint: string;
  leaderboardSubmissionRevision: number | null;
  leaderboardPeakWhiteMatrixPerMinute: number | null;
}

interface AdminAccountSummary {
  accountId: string;
  username: string;
  displayName: string;
  createdAt: number;
  emailBound: boolean;
  emailVerified: boolean;
  leaderboardVisible: boolean;
  sessionCount: number;
  cloud: { bytes: number; slots: Record<string, { revision: number; size: number; historyCount: number }> };
  loginDisabledUntil: number | null;
  leaderboardRestricted: boolean;
  leaderboardReview: LeaderboardReview | null;
  leaderboardResumeAfterRevision: number | null;
}

interface CloudHistoryPrunePreview {
  previewId: string;
  generatedAt: number;
  limit: number;
  deletionCount: number;
  reasons: { orphanAccount: number; invalidSlot: number; expiredRevision: number };
  confirmation: string;
}

const ADMIN_TOKEN_KEY = "dsp-idle-network.admin-token.v1";
const EVENT_LABELS: Record<string, string> = {
  page_view: "打开网站",
  game_enter: "进入工厂",
  new_game: "新建游戏",
  continue_game: "继续游戏",
  load_save: "加载存档",
  import_save: "导入存档",
  cloud_register: "注册云账号",
  cloud_login: "登录云账号",
  cloud_upload: "上传云存档",
  cloud_download: "下载云存档",
  open_technology: "打开科技树",
  open_recipes: "打开生产资料库",
  open_statistics: "打开生产统计",
  open_star_map: "打开星图",
  open_campaign: "打开战役",
  building_place: "放置建筑",
  belt_connect: "建立运输线",
  research_queue: "加入科研队列",
  mobile_nav_open: "手机主导航",
  mobile_sheet_open: "手机抽屉打开",
  mobile_sheet_snap: "手机抽屉切档",
  mobile_build_select: "手机选择建造",
  mobile_place_success: "手机放置成功",
  mobile_place_cancel: "手机取消放置",
  mobile_connect_success: "手机连线成功",
  mobile_connect_fail: "手机连线失败",
  mobile_inspector_expand: "手机展开检查器",
  mobile_workspace_open: "手机打开工作区",
  mobile_back_action: "手机返回操作",
  milestone_red_matrix: "达成红糖",
  milestone_oil_chain: "完成石油链",
  milestone_yellow_matrix: "达成黄糖",
  milestone_interstellar: "建立跨星球物流",
  milestone_dyson_swarm: "建立戴森云",
  milestone_universe_matrix: "达成白糖",
};
const AUDIT_LABELS: Record<string, string> = {
  "account.register": "账号注册",
  "account.login": "账号登录",
  "account.logout": "账号退出",
  "account.email_verified": "邮箱验证",
  "account.verification_requested": "重发验证邮件",
  "account.password_reset_requested": "请求密码重置",
  "account.password_reset": "完成密码重置",
  "account.password_changed": "修改密码",
  "account.session_revoked": "撤销设备会话",
  "account.data_exported": "导出账号数据",
  "account.deleted": "注销账号",
  "cloud.revision_restored": "恢复云修订",
  "cloud.history_pruned_confirmed": "确认裁剪云存档历史",
  "admin.account_summary_viewed": "管理员查看账号摘要",
  "admin.account_revoke_sessions": "管理员撤销全部会话",
  "admin.account_disable_login": "管理员限制账号登录",
  "admin.account_enable_login": "管理员恢复账号登录",
  "admin.account_restrict_leaderboard": "管理员移除排行榜",
  "admin.account_restore_leaderboard": "管理员批准排行榜复核",
  "admin.account_approve_leaderboard_review": "管理员确认排行榜复核",
  "admin.account_delete_account": "管理员彻底注销账号",
  "admin.player_estimates_backfilled": "管理员回填玩家估算",
  "leaderboard.review_queued": "排行榜异常进入待复核",
  "leaderboard.review_approved": "排行榜异常复核通过",
};

function readToken(): string {
  try { return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? ""; } catch { return ""; }
}

function writeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // A storage-restricted browser can still use the token until reload.
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

function formatBytes(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "--";
  return `${((value ?? 0) / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatStorageBytes(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "--";
  const bytes = Math.max(0, value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatTime(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
}

function operationalStatusLabel(status: OperationalStatus | undefined): string {
  if (!status?.configured) return "未配置";
  if (status.ok && status.completedAt) return formatTime(status.completedAt);
  if (status.state === "pending") return "等待首次运行";
  if (status.state === "unreadable") return "状态不可读";
  return status.failedAt ? `失败 ${formatTime(status.failedAt)}` : "最近运行失败";
}

async function fetchAdminMetrics(token: string, days: number): Promise<AdminMetrics> {
  const response = await fetch(`/api/admin/metrics?days=${days}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `后台返回 ${response.status}`);
  return payload as AdminMetrics;
}

async function adminRequest<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `后台返回 ${response.status}`);
  return payload as T;
}

async function fetchLeaderboardReviews(token: string): Promise<LeaderboardReview[]> {
  const result = await adminRequest<{ entries: LeaderboardReview[] }>(token, "/api/admin/leaderboard/reviews?limit=200");
  return Array.isArray(result.entries) ? result.entries : [];
}

export function AdminDashboard() {
  const [token, setToken] = useState(readToken);
  const [draftToken, setDraftToken] = useState(readToken);
  const [days, setDays] = useState(7);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [leaderboardReviews, setLeaderboardReviews] = useState<LeaderboardReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountIdDraft, setAccountIdDraft] = useState("");
  const [account, setAccount] = useState<AdminAccountSummary | null>(null);
  const [accountAction, setAccountAction] = useState<AdminAccountAction>("revoke-sessions");
  const [accountConfirmation, setAccountConfirmation] = useState("");
  const [operationsMessage, setOperationsMessage] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [prunePreview, setPrunePreview] = useState<CloudHistoryPrunePreview | null>(null);
  const [pruneConfirmation, setPruneConfirmation] = useState("");

  const refresh = useCallback(async (candidate = token, selectedDays = days) => {
    if (!candidate) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchAdminMetrics(candidate, selectedDays);
      // Keep the main dashboard usable during a rolling deployment where the
      // new review endpoint may not have reached the active API yet.
      let reviews: LeaderboardReview[] = [];
      try { reviews = await fetchLeaderboardReviews(candidate); } catch { /* optional during rollout */ }
      setMetrics(next);
      setLeaderboardReviews(reviews);
      setToken(candidate);
      writeToken(candidate);
    } catch (reason) {
      setMetrics(null);
      setLeaderboardReviews([]);
      setError(reason instanceof Error ? reason.message : "无法读取运营数据");
    } finally {
      setLoading(false);
    }
  }, [days, token]);

  useEffect(() => {
    if (!token) return;
    void refresh(token, days);
    const timer = window.setInterval(() => void refresh(token, days), 30_000);
    return () => window.clearInterval(timer);
  }, [days, refresh, token]);

  const authenticate = (event: FormEvent) => {
    event.preventDefault();
    const candidate = draftToken.trim();
    if (candidate) void refresh(candidate, days);
  };

  const lookupAccount = async (event?: FormEvent, requestedAccountId?: string) => {
    event?.preventDefault();
    const accountId = (requestedAccountId ?? accountIdDraft).trim();
    if (!accountId) return;
    setOperationBusy(true);
    setOperationsMessage(null);
    try {
      const result = await adminRequest<{ account: AdminAccountSummary }>(token, `/api/admin/account?accountId=${encodeURIComponent(accountId)}`);
      setAccount(result.account);
      setAccountConfirmation("");
    } catch (reason) {
      setAccount(null);
      setOperationsMessage(reason instanceof Error ? reason.message : "账号查询失败");
    } finally {
      setOperationBusy(false);
    }
  };

  const applyAccountAction = async () => {
    if (!account) return;
    setOperationBusy(true);
    setOperationsMessage(null);
    try {
      const result = await adminRequest<{ account: AdminAccountSummary | null }>(token, "/api/admin/account/action", {
        method: "POST",
        body: JSON.stringify({
          accountId: account.accountId,
          action: accountAction,
          confirmation: accountConfirmation,
          ...(accountAction === "delete-account" ? { verifiedBackupAt: metrics?.backups.lastSuccessAt ?? null } : {}),
        }),
      });
      setAccount(result.account);
      setAccountConfirmation("");
      setOperationsMessage(result.account
        ? accountAction === "approve-leaderboard-review"
          ? "已确认本次异常为可接受结果，并重新发布当前排行榜修订"
          : "管理员动作已应用并写入审计；排行榜恢复仍需新云修订重新验证"
        : "账号已彻底注销并写入审计");
      await refresh();
    } catch (reason) {
      setOperationsMessage(reason instanceof Error ? reason.message : "管理员动作失败");
    } finally {
      setOperationBusy(false);
    }
  };

  const previewCloudPrune = async () => {
    setOperationBusy(true);
    setOperationsMessage(null);
    try {
      const result = await adminRequest<{ preview: CloudHistoryPrunePreview }>(token, "/api/admin/cloud-history/prune-preview");
      setPrunePreview(result.preview);
      setPruneConfirmation("");
    } catch (reason) {
      setOperationsMessage(reason instanceof Error ? reason.message : "历史裁剪预览失败");
    } finally {
      setOperationBusy(false);
    }
  };

  const applyCloudPrune = async () => {
    if (!prunePreview) return;
    setOperationBusy(true);
    setOperationsMessage(null);
    try {
      await adminRequest(token, "/api/admin/cloud-history/prune", {
        method: "POST",
        body: JSON.stringify({ previewId: prunePreview.previewId, confirmation: pruneConfirmation }),
      });
      setOperationsMessage(`历史裁剪已完成：预览中的 ${prunePreview.deletionCount} 条过期正文已按事务处理`);
      setPrunePreview(null);
      setPruneConfirmation("");
      await refresh();
    } catch (reason) {
      setOperationsMessage(reason instanceof Error ? reason.message : "历史裁剪失败");
    } finally {
      setOperationBusy(false);
    }
  };

  const today = metrics?.analytics.daily.find((record) => record.day === metrics.analytics.today);
  const maximumPageViews = useMemo(() => Math.max(1, ...(metrics?.analytics.daily.map((record) => record.pageViews) ?? [1])), [metrics]);
  const productEvents = useMemo(() => metrics?.analytics.events.filter((event) => !event.name.startsWith("perf_")) ?? [], [metrics]);

  if (!metrics) {
    return (
      <main className="admin-login-shell">
        <form className="admin-login" onSubmit={authenticate}>
          <span className="admin-brand"><ShieldCheck size={24} /><strong>DSP极简网络</strong><small>运营数据后台</small></span>
          <label><span>管理员凭据</span><div><KeyRound size={17} /><StableTextInput sensitive draftId="admin-credential" type="password" value={draftToken} onValueChange={setDraftToken} autoComplete="current-password" autoFocus /></div></label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={!draftToken.trim() || loading}>{loading ? <RefreshCw className="spin" size={17} /> : <ShieldCheck size={17} />}{loading ? "正在验证" : "进入后台"}</button>
          <a href="/">返回游戏</a>
        </form>
      </main>
    );
  }
  const performance = metrics.analytics.performance ?? {
    pageLoad: { samples: 0, fast: 0, acceptable: 0, slow: 0, verySlow: 0, p75Band: "暂无样本" },
    lcp: { samples: 0, good: 0, needsImprovement: 0, poor: 0, p75Band: "暂无样本" },
    transfer: { samples: 0, light: 0, medium: 0, heavy: 0, p75Band: "暂无样本" },
  };

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <span className="admin-brand"><ShieldCheck size={22} /><strong>DSP极简网络</strong><small>运营后台</small></span>
        <nav aria-label="统计时间范围">{[1, 7, 30, 90].map((value) => <button className={days === value ? "active" : ""} type="button" key={value} onClick={() => setDays(value)}>{value === 1 ? "今日" : `${value} 天`}</button>)}</nav>
        <span className="admin-refresh-state"><i className={loading ? "busy" : ""} />{new Date(metrics.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        <button className="admin-icon-button" type="button" onClick={() => void refresh()} title="刷新数据"><RefreshCw size={17} /></button>
        <button className="admin-icon-button" type="button" onClick={() => { writeToken(""); setToken(""); setDraftToken(""); setMetrics(null); }} title="退出后台"><LogOut size={17} /></button>
      </header>

      <section className="admin-kpi-grid" aria-label="核心运营数据">
        <article><Users size={19} /><span><small>今日访客 UV</small><strong>{formatNumber(today?.uniqueVisitors ?? 0)}</strong></span><em>累计 {formatNumber(metrics.analytics.totalVisitors)}</em></article>
        <article><MousePointerClick size={19} /><span><small>今日访问 PV</small><strong>{formatNumber(today?.pageViews ?? 0)}</strong></span><em>{formatNumber(today?.sessions ?? 0)} 次会话</em></article>
        <article><Activity size={19} /><span><small>今日进入工厂</small><strong>{formatNumber(today?.gameStarts ?? 0)}</strong></span><em>转化 {today?.pageViews ? Math.round(today.gameStarts / today.pageViews * 100) : 0}%</em></article>
        <article><Clock3 size={19} /><span><small>区间活跃时长</small><strong>{formatDuration(metrics.analytics.range.activeSeconds)}</strong></span><em>{metrics.analytics.range.days} 天口径</em></article>
        <article><Radio size={19} /><span><small>当前在线游玩</small><strong>{formatNumber(metrics.players.online)}</strong></span><em>{metrics.players.onlineWindowSeconds} 秒内活跃</em></article>
        <article><Gauge size={19} /><span><small>API P95</small><strong>{metrics.runtime.p95LatencyMs.toFixed(1)} ms</strong></span><em>{formatNumber(metrics.runtime.errors)} 个服务错误</em></article>
      </section>

      <section className="admin-main-grid">
        <article className="admin-trend-panel">
          <header><div><small>访问趋势</small><strong>PV / UV / 进入工厂</strong></div><em>{metrics.timeZone}</em></header>
          <div className="admin-trend-chart">{metrics.analytics.daily.length === 0 ? <p>尚无访问数据</p> : metrics.analytics.daily.map((record) => (
            <div className="admin-trend-day" key={record.day} title={`${record.day} · PV ${record.pageViews} · UV ${record.uniqueVisitors} · 进入 ${record.gameStarts}`}>
              <span><i style={{ height: `${Math.max(3, record.pageViews / maximumPageViews * 100)}%` }} /><b style={{ height: `${Math.max(2, record.uniqueVisitors / maximumPageViews * 100)}%` }} /><em style={{ height: `${Math.max(2, record.gameStarts / maximumPageViews * 100)}%` }} /></span>
              <small>{record.day.slice(5)}</small>
            </div>
          ))}</div>
          <footer><span><i className="pv" />PV</span><span><i className="uv" />UV</span><span><i className="game" />进入工厂</span></footer>
        </article>

        <article className="admin-service-panel">
          <header><div><small>云节点</small><strong>服务与数据安全</strong></div><em>schema v{metrics.schemaVersion}</em></header>
          <dl>
            <div><dt><Database size={15} />存储</dt><dd>{metrics.storage.toUpperCase()}</dd></div>
            <div><dt><Users size={15} />注册账号</dt><dd>{formatNumber(metrics.accounts.users)}</dd></div>
            <div><dt><Activity size={15} />有效会话</dt><dd>{formatNumber(metrics.accounts.activeSessions)}</dd></div>
            <div><dt><Cloud size={15} />云存档</dt><dd>{formatNumber(metrics.accounts.cloudSaves)}</dd></div>
            <div><dt><Gauge size={15} />限流 / 冲突</dt><dd>{metrics.runtime.rateLimited} / {metrics.runtime.cloudConflicts}</dd></div>
            <div><dt><ShieldCheck size={15} />本机快照</dt><dd className={metrics.backups.configured && metrics.backups.lastSuccessAt ? "ready" : "warning"}>{metrics.backups.configured ? formatTime(metrics.backups.lastSuccessAt) : "未配置"}</dd></div>
            <div><dt><Cloud size={15} />异地加密备份</dt><dd className={metrics.backups.offsite?.ok && metrics.backups.offsite.transported ? "ready" : "warning"}>{operationalStatusLabel(metrics.backups.offsite)}</dd></div>
            <div><dt><ShieldCheck size={15} />隔离恢复演练</dt><dd className={metrics.backups.restoreDrill?.ok ? "ready" : "warning"}>{operationalStatusLabel(metrics.backups.restoreDrill)}</dd></div>
            <div><dt><Gauge size={15} />公网探测</dt><dd className={metrics.infrastructure?.ok ? "ready" : "warning"}>{metrics.infrastructure?.checkedAt ? formatTime(metrics.infrastructure.checkedAt) : "等待探测"}</dd></div>
            <div><dt><Database size={15} />磁盘可用</dt><dd className={metrics.infrastructure?.disk?.ok ? "ready" : "warning"}>{formatBytes(metrics.infrastructure?.disk?.freeBytes)} · {metrics.infrastructure?.disk?.freeRatio != null ? `${Math.round(metrics.infrastructure.disk.freeRatio * 100)}%` : "--"}</dd></div>
            <div><dt><ShieldCheck size={15} />TLS 证书</dt><dd className={metrics.infrastructure?.tls?.ok ? "ready" : "warning"}>{metrics.infrastructure?.tls?.daysRemaining != null ? `${metrics.infrastructure.tls.daysRemaining} 天` : "未配置"}</dd></div>
          </dl>
        </article>

        <article className="admin-events-panel">
          <header><div><small>关键事件</small><strong>玩家操作与流程漏斗</strong></div><em>{productEvents.length} 类</em></header>
          <div>{productEvents.length === 0 ? <p>尚无事件数据</p> : productEvents.map((event) => (
            <span key={event.name}><strong>{EVENT_LABELS[event.name] ?? event.name}</strong><i><b style={{ width: `${Math.max(3, event.count / Math.max(1, productEvents[0]?.count ?? 1) * 100)}%` }} /></i><em>{formatNumber(event.count)}</em></span>
          ))}</div>
        </article>

        <article className="admin-meta-panel admin-performance-panel">
          <header><div><small>真实浏览器样本</small><strong>页面加载与资源体积</strong></div><em>隐私分桶</em></header>
          <dl>
            <div><dt>页面加载 P75</dt><dd>{performance.pageLoad.p75Band} · {performance.pageLoad.samples} 份</dd></div>
            <div><dt>加载分布</dt><dd>&lt;1.5s {performance.pageLoad.fast} / 1.5-3s {performance.pageLoad.acceptable} / 慢 {performance.pageLoad.slow + performance.pageLoad.verySlow}</dd></div>
            <div><dt>LCP P75</dt><dd>{performance.lcp.p75Band} · {performance.lcp.samples} 份</dd></div>
            <div><dt>LCP 健康</dt><dd>良好 {performance.lcp.good} / 待改善 {performance.lcp.needsImprovement} / 差 {performance.lcp.poor}</dd></div>
            <div><dt>传输体积 P75</dt><dd>{performance.transfer.p75Band} · {performance.transfer.samples} 份</dd></div>
            <div><dt>传输分布</dt><dd>&lt;1MB {performance.transfer.light} / 1-3MB {performance.transfer.medium} / 重 {performance.transfer.heavy}</dd></div>
          </dl>
        </article>

        <article className="admin-meta-panel">
          <header><div><small>运行摘要</small><strong>请求与玩家数据</strong></div></header>
          <dl>
            <div><dt>本次启动请求</dt><dd>{formatNumber(metrics.runtime.requests)}</dd></div>
            <div><dt>API P50</dt><dd>{metrics.runtime.p50LatencyMs.toFixed(1)} ms</dd></div>
            <div><dt>累计进入玩家</dt><dd>{formatNumber(metrics.players.total)}</dd></div>
            <div><dt>今日进入玩家</dt><dd>{formatNumber(metrics.players.today)}</dd></div>
            <div><dt>反馈 / 客户端错误</dt><dd>{metrics.reports.feedback} / {metrics.reports.clientErrors}</dd></div>
            <div><dt>服务运行时间</dt><dd>{formatDuration(metrics.uptimeSeconds)}</dd></div>
          </dl>
        </article>

        <article className="admin-meta-panel">
          <header><div><small>历史玩家估算</small><strong>实测与估算分开</strong></div><em>不改写权威计数</em></header>
          <dl>
            <div><dt>估算覆盖天数</dt><dd>{formatNumber(metrics.players.estimates?.days ?? 0)}</dd></div>
            <div><dt>最近估算日</dt><dd>{metrics.players.estimates?.latest?.day ?? "无"}</dd></div>
            <div><dt>最近日估算人数</dt><dd>{metrics.players.estimates?.latest ? `${formatNumber(metrics.players.estimates.latest.playersEstimate)}（${metrics.players.estimates.latest.status}）` : "无"}</dd></div>
            <div><dt>最近日实测进入</dt><dd>{metrics.players.estimates?.latest ? formatNumber(metrics.players.estimates.latest.observedPlayers) : "无"}</dd></div>
          </dl>
          <small>估算为每日进入工厂活动的回溯推断，不能与累计唯一玩家相加。</small>
        </article>

        <article className="admin-meta-panel admin-governance-panel">
          <header><div><small>数据库治理</small><strong>增长、队列与备份窗口</strong></div><em>layout v{metrics.governance?.sqlite?.layoutVersion ?? "--"}</em></header>
          <dl>
            <div><dt>SQLite / WAL</dt><dd>{formatStorageBytes(metrics.governance?.sqlite?.databaseBytes)} / {formatStorageBytes(metrics.governance?.sqlite?.walBytes)}</dd></div>
            <div><dt>app_state / 云正文</dt><dd>{formatStorageBytes(metrics.governance?.sqlite?.appStateBytes)} / {formatStorageBytes(metrics.governance?.sqlite?.cloudPayloadBytes)}</dd></div>
            <div><dt>正文行 / 每账号修订</dt><dd>{formatNumber(metrics.governance?.sqlite?.cloudPayloadRows ?? 0)} / {metrics.governance?.sqlite?.averageRevisionsPerAccount ?? 0}</dd></div>
            <div><dt>写入队列 当前 / 峰值</dt><dd>{metrics.runtime.writeQueueDepth ?? 0} / {metrics.runtime.maxWriteQueueDepth ?? 0}</dd></div>
            <div><dt>慢请求 / 慢写入</dt><dd>{metrics.runtime.slowRequests ?? 0} / {metrics.runtime.slowWrites ?? 0}</dd></div>
            <div><dt>备份状态 / 窗口</dt><dd>{metrics.backups.state ?? "--"} / {metrics.backups.dailyWindow ?? "未配置"}</dd></div>
            <div><dt>磁盘保护</dt><dd className={metrics.governance?.disk.protection90Percent ? "warning" : "ready"}>{metrics.governance?.disk.protection90Percent ? "90% 保护已触发" : metrics.governance?.disk.warning80Percent ? "80% 告警" : "正常"}</dd></div>
          </dl>
          <div className="admin-operation-form">
            <button type="button" disabled={operationBusy} onClick={() => void previewCloudPrune()}>生成裁剪预览</button>
            {prunePreview ? <><small>保留每槽最近 {prunePreview.limit} 条；待删除 {prunePreview.deletionCount} 条。预览 ID {prunePreview.previewId.slice(0, 12)}</small><StableTextInput sensitive draftId="admin-prune-confirmation" value={pruneConfirmation} onValueChange={setPruneConfirmation} placeholder={`输入 ${prunePreview.confirmation}`} /><button className="danger" type="button" disabled={operationBusy || pruneConfirmation !== prunePreview.confirmation} onClick={() => void applyCloudPrune()}>确认事务裁剪</button></> : null}
          </div>
        </article>

        <article className="admin-meta-panel admin-review-panel">
          <header><div><small>排行榜人工复核</small><strong>待处理异常 {formatNumber(metrics?.leaderboardReviews?.pending ?? leaderboardReviews.length)}</strong></div><em>不自动封禁</em></header>
          <div className="admin-review-list">
            {leaderboardReviews.length === 0 ? <p>暂无待复核异常</p> : leaderboardReviews.map((review) => (
              <div className="admin-review-row" key={review.accountId}>
                <span><strong>{review.displayName ?? "未命名账号"}</strong><small>{review.username ?? "--"} · 修订 {review.detectedRevision} · {formatTime(review.lastDetectedAt)}</small></span>
                <span><small>{review.findings.map((finding) => finding.code).join("、")}</small><em>{review.occurrences} 次</em></span>
                <button type="button" disabled={operationBusy} onClick={() => { setAccountIdDraft(review.accountId); void lookupAccount(undefined, review.accountId); }}>查询账号</button>
              </div>
            ))}
          </div>
          <small>异常只进入此队列；确认异常请查询账号后选择“移除排行榜”，确认正常请选择“确认复核并发布”。登录、云存档和账号不会因入队被修改。</small>
        </article>

        <article className="admin-meta-panel admin-account-panel">
          <header><div><small>账号处置</small><strong>精确账号 ID、最小化摘要与审计</strong></div><em>不读取存档正文</em></header>
          <form className="admin-operation-form" onSubmit={(event) => void lookupAccount(event)}>
            <StableTextInput draftId="admin-account-id" value={accountIdDraft} onValueChange={setAccountIdDraft} placeholder="精确 account ID" autoComplete="off" />
            <button type="submit" disabled={operationBusy || !accountIdDraft.trim()}>只读查询</button>
          </form>
          {account ? <div className="admin-account-summary">
            <dl>
              <div><dt>账号</dt><dd>{account.username} / {account.displayName}</dd></div>
              <div><dt>会话 / 云占用</dt><dd>{account.sessionCount} / {formatStorageBytes(account.cloud.bytes)}</dd></div>
              <div><dt>登录限制</dt><dd>{account.loginDisabledUntil ? formatTime(account.loginDisabledUntil) : "无"}</dd></div>
              <div><dt>排行榜限制</dt><dd>{account.leaderboardRestricted ? "已冻结" : account.leaderboardResumeAfterRevision ? `等待修订 > ${account.leaderboardResumeAfterRevision}` : "无"}</dd></div>
            </dl>
            <div className="admin-operation-form">
              <select value={accountAction} onChange={(event) => { setAccountAction(event.target.value as AdminAccountAction); setAccountConfirmation(""); }}>
                <option value="revoke-sessions">撤销全部会话</option><option value="disable-login">限制登录 24 小时</option><option value="enable-login">恢复登录</option><option value="restrict-leaderboard">移除排行榜</option><option value="approve-leaderboard-review">确认复核并发布</option><option value="restore-leaderboard">批准复核（需新修订）</option><option value="delete-account">彻底注销（需 24h 内备份）</option>
              </select>
              <small>二次确认：CONFIRM:{accountAction}:{account.accountId}</small>
              <StableTextInput sensitive draftId="admin-account-confirmation" value={accountConfirmation} onValueChange={setAccountConfirmation} placeholder="输入完整二次确认文字" />
              <button className="danger" type="button" disabled={operationBusy || accountConfirmation !== `CONFIRM:${accountAction}:${account.accountId}`} onClick={() => void applyAccountAction()}>应用并写审计</button>
            </div>
          </div> : null}
          {operationsMessage ? <p className="admin-operation-message" role="status">{operationsMessage}</p> : null}
        </article>

        <article className="admin-audit-panel">
          <header><div><small>安全审计</small><strong>账号与云端敏感操作</strong></div><em>{formatNumber(metrics.audit?.entries ?? 0)} 条</em></header>
          <div>{metrics.audit?.recent.length ? metrics.audit.recent.slice(0, 8).map((entry, index) => <span key={`${entry.occurredAt}-${entry.action}-${index}`}><KeyRound size={14} /><strong>{AUDIT_LABELS[entry.action] ?? entry.action}</strong><small>{entry.clientType}</small><em>{formatTime(entry.occurredAt)}</em></span>) : <p>尚无安全审计记录</p>}</div>
        </article>
      </section>
    </main>
  );
}
