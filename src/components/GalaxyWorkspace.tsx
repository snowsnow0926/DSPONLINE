import {
  Activity,
  BarChart3,
  Check,
  Cloud,
  CloudOff,
  Crown,
  Database,
  Download,
  Eye,
  EyeOff,
  Flag,
  Factory,
  Gauge,
  Globe2,
  History,
  LockKeyhole,
  Link2,
  LogIn,
  LogOut,
  Orbit,
  Plus,
  RadioTower,
  RotateCcw,
  Send,
  Save,
  ShieldCheck,
  Trophy,
  Trash2,
  Unlink,
  UserRound,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ACCOUNT_AVATARS, getActiveAccount, getGalacticThroughputSnapshot, type AccountProfileChanges, type AccountState } from "../game/account";
import { CloudApiError, clearCloudSyncMarker, compareCloudSave, deleteCloudSave, describeCloudUploadError, downloadCloudSave, fetchCloudLeaderboard, fetchCloudLeaderboardMe, fetchCloudSaveHistory, fetchSpeedrunLeaderboard, loginCloudAccount, logoutCloudAccount, markCloudSaveSynchronized, refreshCloudSaveMetadata, registerCloudAccount, restoreCloudSaveRevision, resumeCloudSession, setCloudLeaderboardVisibility, submitCloudLeaderboard, submitSpeedrunResult, summarizeCloudPayload, uploadCloudSave, type CloudLeaderboardEntry, type CloudLeaderboardMe, type CloudLeaderboardMetricWindow, type CloudSave, type CloudSaveMetadata, type CloudSaveSlot, type CloudSession, type CloudSyncState, type CloudUploadDiagnostics, type CloudUploadStage, type SpeedrunLeaderboardEntry } from "../game/cloud";
import { exportGame, exportGameSlotFromPersistence, getSaveSlotSummaries, inspectSave, saveGameSlotVerified, type SaveSlotId } from "../game/storage";
import {
  LEADERBOARD_CATEGORIES,
  LEADERBOARD_SEASONS,
  formatLeaderboardValue,
  getLeaderboardMetrics,
  getLeaderboardSnapshot,
  getLeaderboardValue,
  type LeaderboardEntry,
  type LeaderboardCategoryId,
} from "../game/leaderboard";
import type { GameState } from "../game/types";
import type { SpeedrunTargetId } from "../game/types";
import { SPEEDRUN_SEASON_ID, SPEEDRUN_TARGET_IDS, SPEEDRUN_TARGETS, getSpeedrunSummary, formatSpeedrunDuration } from "../game/speedrun";
import { CloudAccountSecurity } from "./CloudAccountSecurity";
import { CloudSaveConflictDialog } from "./CloudSaveConflictDialog";
import { CloudSaveSlotsPanel } from "./CloudSaveSlotsPanel";
import { SaveDeleteDialog, type SaveDeleteTarget } from "./SaveDeleteDialog";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import { PowerValue } from "./PowerValue";
import { StableTextInput, clearStableTextDraft } from "./CompositionSafeInput";
import { CloudSaveStatusCenter } from "./CloudSaveStatusCenter";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { cloudSaveCapacityDetails, type CloudSaveCapacityDetails } from "../game/cloudSaveCapacity";
import { cloudSyncStatusFromUpload, writeCloudSyncStatus } from "../game/cloudSyncStatus";
import { exportTextFile } from "../game/fileExport";
import { getPrimaryLocalSaveRevision } from "../game/localSaveStore";

type GalaxyTab = "ranking" | "speedrun" | "cloud" | "account";

interface GalaxyWorkspaceProps {
  open: boolean;
  focusTab?: GalaxyTab | null;
  accountState: AccountState;
  game: GameState;
  onClose: () => void;
  onUpdateProfile: (changes: AccountProfileChanges) => void;
  onUpdateCloudBinding: (cloud: { id: string; email: string } | null) => void;
  onCreateAccount: (displayName: string) => void;
  onSwitchAccount: (accountId: string) => void;
  onRestoreCloudSave: (payload: string) => Promise<{ success: boolean; message: string }>;
}

const CATEGORY_ICONS: Record<LeaderboardCategoryId, ReactNode> = {
  power: <Zap size={15} />,
  upload: <Database size={15} />,
  "white-rate": <Gauge size={15} />,
  dyson: <Orbit size={15} />,
  throughput: <Factory size={15} />,
  galaxy: <Trophy size={15} />,
};

function formatMetric(value: number, digits = 0): string {
  return digits > 0 && Math.abs(value) < 10_000 ? value.toFixed(digits) : formatQuantityCompact(Math.floor(value));
}

function formatTimestamp(timestamp: number): string {
  if (timestamp <= 0) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function cloudSyncLabel(state: CloudSyncState): string {
  if (state === "synced") return "本地与云端一致";
  if (state === "local-newer" || state === "local-only") return "当前工厂有待上传进度";
  if (state === "cloud-newer" || state === "cloud-only") return "其他设备有云端更新";
  if (state === "conflict" || state === "unbound") return "本地与云端需要选择版本";
  return "尚未建立云存档";
}

function cloudUploadStageLabel(stage: CloudUploadStage): string {
  if (stage === "compressing") return "压缩存档";
  if (stage === "sending") return "发送云端";
  if (stage === "confirming") return "正在核对云端是否已保存";
  return "等待服务器确认";
}

function leaderboardWindowMessage(window: CloudLeaderboardMetricWindow | null, category: LeaderboardCategoryId, hasHistoricalPeak: boolean): string | null {
  if (!window) return null;
  const metric = category === "white-rate" ? "白糖产量" : "实际结算吞吐";
  const retained = hasHistoricalPeak ? "；已验证的历史峰值仍会保留" : "";
  const observed = Math.max(0, Math.floor(window.observedSeconds));
  if (window.status === "missing_adjacent_revision") return `缺少相邻普通主云修订，当前已观察 ${observed} 个模拟秒；完成第二次有效同步后再统计${retained}`;
  if (window.status === "interval_too_short") return `统计窗口已观察 ${observed} 个模拟秒，还需 ${Math.ceil(window.remainingSeconds)} 秒才能统计${metric}${retained}`;
  if (window.status === "elapsed_not_increasing") return `相邻修订的模拟时间没有增加（已观察 ${observed} 秒），本次不计入${metric}排名${retained}`;
  if (window.status === "valid_zero_production") return `有效窗口，当前无产出（已观察 ${observed} 个模拟秒）`;
  if (window.status === "ranked") return `服务器已采用主云修订 ${window.fromRevision ?? "?"} → ${window.toRevision ?? "?"} 的 ${observed} 秒窗口认证${metric}`;
  return `相邻主云窗口暂不可用（已观察 ${observed} 个模拟秒），本次不更新${metric}成绩${retained}`;
}

function leaderboardStatusMessage(me: CloudLeaderboardMe | null): string | null {
  if (!me) return null;
  if (me.status === "missing_main_save") return "尚未上传普通模式主云存档；速通主档和手动槽位不会参与银河排行";
  if (me.status === "revalidation_required") return `排行榜正在等待新的普通模式主云修订完成复核${me.reviewResumeAfterRevision ? `（需高于修订 ${me.reviewResumeAfterRevision}）` : ""}`;
  if (me.status === "restricted") return "当前账号受到排行榜限制；本地与云存档仍保持正常，不会因此被修改";
  if (me.status === "hidden") return "当前账号已退出公开排行榜；云存档仍正常同步";
  if (me.status === "unavailable") return "服务器暂时无法生成当前账号成绩；玩家存档、云存档和生产数据不会因此被修改";
  return null;
}

export function GalaxyWorkspace({
  open,
  focusTab,
  accountState,
  game,
  onClose,
  onUpdateProfile,
  onUpdateCloudBinding,
  onCreateAccount,
  onSwitchAccount,
  onRestoreCloudSave,
}: GalaxyWorkspaceProps) {
  const [tab, setTab] = useState<GalaxyTab>("ranking");
  const [speedrunTarget, setSpeedrunTarget] = useState<SpeedrunTargetId>(SPEEDRUN_TARGET_IDS[0]);
  const [speedrunEntries, setSpeedrunEntries] = useState<SpeedrunLeaderboardEntry[]>([]);
  const [speedrunStatus, setSpeedrunStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [speedrunMessage, setSpeedrunMessage] = useState<string | null>(null);
  const [category, setCategory] = useState<LeaderboardCategoryId>("galaxy");
  const [seasonId, setSeasonId] = useState(LEADERBOARD_SEASONS[0].id);
  const [uploadRevision, setUploadRevision] = useState(0);
  const [uploadState, setUploadState] = useState<"idle" | "success" | "blocked">("idle");
  const [nameDraft, setNameDraft] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [cloudSession, setCloudSession] = useState<CloudSession>({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null });
  const [cloudMode, setCloudMode] = useState<"login" | "register">("login");
  const [cloudIdentifier, setCloudIdentifier] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudDisplayName, setCloudDisplayName] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudUploadActive, setCloudUploadActive] = useState(false);
  const cloudUploadAbortRef = useRef<AbortController | null>(null);
  const [cloudUploadCapacity, setCloudUploadCapacity] = useState<CloudSaveCapacityDetails | null>(null);
  const [cloudUploadErrorCode, setCloudUploadErrorCode] = useState<string | null>(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [cloudEntries, setCloudEntries] = useState<CloudLeaderboardEntry[]>([]);
  const [cloudLeaderboardMe, setCloudLeaderboardMe] = useState<CloudLeaderboardMe | null>(null);
  const [leaderboardMeError, setLeaderboardMeError] = useState<string | null>(null);
  const [leaderboardStatus, setLeaderboardStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [leaderboardVisibilityBusy, setLeaderboardVisibilityBusy] = useState(false);
  const [cloudHistory, setCloudHistory] = useState<CloudSaveMetadata[]>([]);
  const [pendingCloudSave, setPendingCloudSave] = useState<CloudSave | null>(null);
  const cloudMailAvailable = cloudSession.mailAvailable;
  const [cloudConflict, setCloudConflict] = useState<{ slot: CloudSaveSlot; localPayload: string; remote: CloudSaveMetadata } | null>(null);
  const [cloudDeleteRequest, setCloudDeleteRequest] = useState<(SaveDeleteTarget & { slot: CloudSaveSlot; mode: GameState["mode"]; metadata: CloudSaveMetadata }) | null>(null);
  const [localCloudPayload, setLocalCloudPayload] = useState<string | null>(null);
  const [localSaveSlots, setLocalSaveSlots] = useState(() => getSaveSlotSummaries(game.mode));
  const account = getActiveAccount(accountState);
  const speedrunSummary = useMemo(() => getSpeedrunSummary(game), [game]);
  const ownSpeedrunPublicId = cloudSession.user?.speedrunPublicId ?? cloudSession.user?.id;
  const metrics = useMemo(() => getLeaderboardMetrics(account.ledger), [account.ledger]);
  const localNominalThroughput = useMemo(() => getGalacticThroughputSnapshot(game), [game]);
  const snapshot = useMemo(
    () => getLeaderboardSnapshot(account.profile, account.ledger, category, seasonId),
    [account.ledger, account.profile, category, seasonId, uploadRevision],
  );
  const cloudComparison = cloudSession.status === "authenticated" && cloudSession.user
    ? compareCloudSave(cloudSession.user.id, localCloudPayload, cloudSession.cloudSave, "main", game.mode)
    : null;
  const displayEntries = useMemo<LeaderboardEntry[]>(() => {
    if (leaderboardStatus === "error") return snapshot.entries;
    if (leaderboardStatus !== "ready") return [];
    const currentUserId = cloudLeaderboardMe?.entry?.userId;
    const entries = cloudEntries.map((entry) => ({
      ...entry,
      isLocal: cloudSession.status === "authenticated" && Boolean(currentUserId) && entry.userId === currentUserId,
      submitted: true,
    } satisfies LeaderboardEntry));
    if (cloudSession.status === "authenticated" && cloudLeaderboardMe?.entry && !entries.some((entry) => entry.isLocal)) {
      entries.push({ ...cloudLeaderboardMe.entry, isLocal: true, submitted: true });
    }
    return entries;
  }, [cloudEntries, cloudLeaderboardMe, cloudSession.status, leaderboardStatus, snapshot.entries]);
  const displayedLocalEntry = displayEntries.find((entry) => entry.isLocal);
  const serverLocalEntry = leaderboardStatus === "ready" ? cloudLeaderboardMe?.entry ?? undefined : undefined;
  const serverMetrics = leaderboardStatus === "ready" ? cloudLeaderboardMe?.serverMetrics ?? null : null;
  const activePlanetThroughput = serverMetrics?.activePlanetThroughputPerMinute
    ?? localNominalThroughput.activePlanetValue;
  const galacticThroughput = serverMetrics?.galacticThroughputPerMinute
    ?? localNominalThroughput.galacticValue;
  const nominalThroughputMetricVersion = serverMetrics?.nominalThroughputMetricVersion
    ?? localNominalThroughput.metricVersion;
  const leaderboardVisible = cloudSession.status === "authenticated"
    ? cloudSession.user?.leaderboardVisible !== false
    : account.profile.privacy === "public";
  const cloudLeaderboardEligible = game.mode === "normal" && cloudSession.status === "authenticated" && Boolean(cloudSession.cloudSave) && leaderboardVisible;
  const selectedMetricWindow = cloudLeaderboardMe?.latestWindowState ?? null;
  const rawServerWhiteValue = serverMetrics?.peakWhiteMatrixPerMinute ?? null;
  const rawServerThroughputValue = serverMetrics?.peakThroughputPerMinute ?? null;
  const serverWhiteValue = rawServerWhiteValue !== null && (rawServerWhiteValue > 0 || category === "white-rate" && selectedMetricWindow?.valid)
    ? rawServerWhiteValue
    : null;
  const serverThroughputValue = rawServerThroughputValue !== null && (rawServerThroughputValue > 0 || category === "throughput" && selectedMetricWindow?.valid)
    ? rawServerThroughputValue
    : null;
  const serverCategoryValue = category === "white-rate"
    ? serverWhiteValue
    : category === "throughput"
      ? serverThroughputValue
      : serverMetrics ? getLeaderboardValue(serverMetrics, category) : null;
  const localCategoryValue = getLeaderboardValue(metrics, category);
  const categoryValueForDisplay = cloudSession.status === "authenticated" ? serverCategoryValue : localCategoryValue;
  const categoryValueLabel = categoryValueForDisplay === null ? "--" : formatLeaderboardValue(categoryValueForDisplay, category);
  const hasHistoricalPeak = (serverCategoryValue ?? 0) > 0;
  const metricWindowMessage = leaderboardWindowMessage(selectedMetricWindow, category, hasHistoricalPeak);
  const statusMessage = leaderboardStatusMessage(cloudLeaderboardMe);
  const serverMetricPending = cloudSession.status === "authenticated" && (category === "white-rate" || category === "throughput") && serverCategoryValue === null;
  const localServerMetricMessage = cloudSession.status === "authenticated" && category === "throughput"
    ? serverCategoryValue === null && localCategoryValue > 0
      ? `本地 60 秒最佳为 ${formatLeaderboardValue(localCategoryValue, category)}/min；服务器尚无有效窗口，本地值不会计入服务器排行榜。`
      : serverCategoryValue !== null && Math.abs(serverCategoryValue - localCategoryValue) > Math.max(1, Math.abs(serverCategoryValue) * 0.000001)
        ? `本地 60 秒最佳为 ${formatLeaderboardValue(localCategoryValue, category)}/min，服务器认证峰值为 ${formatLeaderboardValue(serverCategoryValue, category)}/min；服务器排行榜只采用普通模式主云存档。`
        : null
    : null;
  const rankLabel = cloudSession.status !== "authenticated"
    ? "未登录"
    : leaderboardStatus === "loading"
      ? "读取中"
      : leaderboardStatus === "error"
        ? "本地预览"
        : leaderboardMeError
          ? "认证状态不可用"
          : cloudLeaderboardMe?.rank
            ? `#${cloudLeaderboardMe.rank}${cloudLeaderboardMe.rank > 100 ? " · Top 100 外" : ""}`
            : cloudLeaderboardMe?.status === "hidden" || !leaderboardVisible
              ? "已退出"
              : cloudLeaderboardMe?.status === "restricted"
                ? "已限制"
                : cloudLeaderboardMe?.status === "revalidation_required"
                  ? "等待复核"
                  : cloudLeaderboardMe?.status === "missing_main_save"
                    ? "待同步"
                    : ["missing_adjacent_revision", "interval_too_short", "elapsed_not_increasing"].includes(cloudLeaderboardMe?.status ?? "")
                      ? "等待统计"
                      : cloudLeaderboardMe?.status === "valid_zero_production"
                        ? "有效零产出"
                        : "未生成";
  const rankDetail = leaderboardStatus === "loading"
    ? "正在读取当前账户的服务器认证排名"
    : leaderboardStatus === "error"
      ? "排行榜暂时不可达，当前只显示本地预览数据"
      : leaderboardMeError
        ? leaderboardMeError
        : statusMessage
    ?? metricWindowMessage
    ?? (serverLocalEntry
      ? cloudLeaderboardMe && cloudLeaderboardMe.rank !== null && cloudLeaderboardMe.rank > 100
        ? `服务器认证成绩已计入；完整榜共 ${cloudLeaderboardMe.totalEntries} 条`
        : "服务器认证成绩已计入"
      : cloudSession.status === "authenticated" ? "上传主云存档后自动加入" : "访客可查看真实排名");
  const leaderboardSourceLabel = `${cloudLeaderboardMe?.mode === "normal" ? "普通模式" : "普通模式"} · ${cloudLeaderboardMe?.slot === "main" ? "主存档" : "主存档"}${cloudLeaderboardMe?.latestCloudRevision ? ` · 修订 ${cloudLeaderboardMe.latestCloudRevision}` : ""}`;

  useEffect(() => {
    if (open && focusTab) setTab(focusTab);
  }, [focusTab, open]);
  useEffect(() => () => cloudUploadAbortRef.current?.abort(), []);
  useEffect(() => {
    if (!open || tab !== "speedrun") return;
    let cancelled = false;
    setSpeedrunStatus("loading");
    void fetchSpeedrunLeaderboard(speedrunTarget, SPEEDRUN_SEASON_ID)
      .then((entries) => { if (!cancelled) { setSpeedrunEntries(entries); setSpeedrunStatus("ready"); setSpeedrunMessage(null); } })
      .catch((error) => { if (!cancelled) { setSpeedrunStatus("error"); setSpeedrunMessage(error instanceof Error ? error.message : "速通排行榜暂时不可用"); } });
    return () => { cancelled = true; };
  }, [open, speedrunTarget, tab]);
  useEffect(() => setNameDraft(account.profile.displayName), [account.profile.displayName, account.profile.id]);
  useEffect(() => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const privacy = cloudSession.user.leaderboardVisible === false ? "private" : "public";
    if (account.profile.privacy !== privacy) onUpdateProfile({ privacy });
  }, [account.profile.privacy, cloudSession.status, cloudSession.user, onUpdateProfile]);
  useEffect(() => {
    setLocalCloudPayload(open && tab === "cloud" ? exportGame(game) : null);
    if (open && tab === "cloud") setLocalSaveSlots(getSaveSlotSummaries(game.mode));
  }, [cloudSession.cloudSave?.revision, game.mode, open, tab]);
  useEffect(() => {
    if (uploadState === "idle") return;
    const timer = window.setTimeout(() => setUploadState("idle"), 2200);
    return () => window.clearTimeout(timer);
  }, [uploadState]);
  useEffect(() => {
    let active = true;
    void resumeCloudSession(game.mode).then((session) => { if (active) setCloudSession(session); });
    return () => { active = false; };
  }, [game.mode]);
  useEffect(() => {
    if (!open || cloudSession.status === "checking") return;
    if (cloudSession.status === "offline") {
      setCloudLeaderboardMe(null);
      setLeaderboardMeError(null);
      setLeaderboardStatus("error");
      setLeaderboardError(cloudSession.message ?? "排行榜节点暂时不可达，当前显示本地回退数据");
      return;
    }
    let active = true;
    setLeaderboardStatus("loading");
    setLeaderboardError(null);
    setLeaderboardMeError(null);
    setCloudLeaderboardMe(null);
    void (async () => {
      try {
        const entries = await fetchCloudLeaderboard(category, seasonId);
        let me: CloudLeaderboardMe | null = null;
        let meError: string | null = null;
        if (cloudSession.status === "authenticated") {
          try {
            me = await fetchCloudLeaderboardMe(category, seasonId);
          } catch (error) {
            meError = error instanceof Error ? error.message : "当前账户认证排名读取失败";
          }
        }
        if (!active) return;
        setCloudEntries(entries);
        setCloudLeaderboardMe(me);
        setLeaderboardMeError(meError);
        setLeaderboardError(meError);
        setLeaderboardStatus("ready");
      } catch (error) {
        if (!active) return;
        setCloudEntries([]);
        setCloudLeaderboardMe(null);
        setLeaderboardMeError(null);
        setLeaderboardStatus("error");
        setLeaderboardError(error instanceof Error ? error.message : "排行榜读取失败");
      }
    })();
    return () => { active = false; };
  }, [category, cloudSession.status, cloudSession.user?.id, open, seasonId, uploadRevision]);
  useEffect(() => {
    if (!open || cloudSession.status !== "authenticated") {
      setCloudHistory([]);
      return;
    }
    let active = true;
    void fetchCloudSaveHistory("main", game.mode).then((history) => { if (active) setCloudHistory(history); }).catch(() => { if (active) setCloudHistory([]); });
    return () => { active = false; };
  }, [cloudSession.cloudSave?.revision, cloudSession.status, game.mode, open]);

  if (!open) return null;

  const upload = async () => {
    if (cloudSession.status !== "authenticated") {
      setLeaderboardError("请先登录云账号并上传主云存档，再刷新排行榜");
      setUploadState("blocked");
      return;
    }
    if (!cloudSession.cloudSave) {
      setLeaderboardError("请先在云存档页面上传当前主存档，再刷新排行榜");
      setUploadState("blocked");
      return;
    }
    if (!leaderboardVisible) {
      setLeaderboardError("当前账号已退出公开排行榜，请先重新加入");
      setUploadState("blocked");
      return;
    }
    try {
      await submitCloudLeaderboard(seasonId);
      const [entries, me] = await Promise.all([
        fetchCloudLeaderboard(category, seasonId),
        fetchCloudLeaderboardMe(category, seasonId),
      ]);
      setCloudEntries(entries);
      setCloudLeaderboardMe(me);
      setLeaderboardMeError(null);
      setLeaderboardStatus("ready");
      setLeaderboardError(null);
    } catch (error) {
      setLeaderboardError(error instanceof Error ? error.message : "排行榜刷新失败");
      setUploadState("blocked");
      return;
    }
    setUploadState("success");
    setUploadRevision((revision) => revision + 1);
  };

  const updateLeaderboardVisibility = async (visible: boolean) => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) {
      onUpdateProfile({ privacy: visible ? "public" : "private" });
      return;
    }
    setLeaderboardVisibilityBusy(true);
    setLeaderboardError(null);
    try {
      const user = await setCloudLeaderboardVisibility(visible);
      setCloudSession((current) => ({ ...current, user }));
      onUpdateProfile({ privacy: visible ? "public" : "private" });
      setUploadRevision((revision) => revision + 1);
      setCloudMessage(visible
        ? cloudSession.cloudSave ? "已重新加入排行榜，排名已按主云存档恢复" : "已允许参与排行榜，上传主云存档后自动加入"
        : "已退出排行榜，公开排名已移除");
    } catch (error) {
      setLeaderboardError(error instanceof Error ? error.message : "排行榜参与设置更新失败");
    } finally {
      setLeaderboardVisibilityBusy(false);
    }
  };

  const authenticateCloud = async () => {
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const session = cloudMode === "register"
        ? await registerCloudAccount(cloudIdentifier, cloudPassword, cloudDisplayName || account.profile.displayName)
        : await loginCloudAccount(cloudIdentifier, cloudPassword);
      setCloudSession(session);
      setCloudPassword("");
      clearStableTextDraft("galaxy-cloud-identifier");
      clearStableTextDraft("galaxy-cloud-display-name");
      setCloudMessage(cloudMode === "register" ? "云账户已创建，云存档与自动同步已开放" : "云账户已登录，本地存档保持不变");
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "云账户操作失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const saveCurrentFactoryToCloud = async () => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const userId = cloudSession.user.id;
    const localPayload = exportGame(game);
    const initialCapacity = cloudSaveCapacityDetails(new TextEncoder().encode(localPayload).byteLength);
    setCloudUploadCapacity(initialCapacity);
    setCloudUploadErrorCode(null);
    writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", "preparing", { comparison: cloudComparison?.state ?? null, cloud: cloudSession.cloudSave, message: "正在生成和校验当前主存档", sizes: initialCapacity }));
    setCloudUploadActive(true);
    setCloudBusy(true);
    setCloudMessage(null);
    const controller = new AbortController();
    cloudUploadAbortRef.current = controller;
    try {
      const comparison = compareCloudSave(userId, localPayload, cloudSession.cloudSave, "main", game.mode);
      if (cloudSession.cloudSave && ["cloud-newer", "conflict", "unbound"].includes(comparison.state)) {
        setCloudConflict({ slot: "main", localPayload, remote: cloudSession.cloudSave });
        setCloudMessage("检测到本地与云端进度分叉，请先选择保留版本");
        return;
      }
      const uploaded = await uploadCloudSave(localPayload, cloudSession.cloudSave?.revision ?? 0, "main", { mode: game.mode,
        signal: controller.signal,
        onStage: (stage) => {
          const message = cloudUploadStageLabel(stage);
          setCloudMessage(message);
          writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", stage === "compressing" ? "compressing" : stage === "confirming" ? "confirming" : "uploading", { comparison: cloudComparison?.state ?? null, cloud: cloudSession.cloudSave, message, sizes: initialCapacity }));
        },
        onDiagnostics: (diagnostics: CloudUploadDiagnostics) => setCloudUploadCapacity(diagnostics.capacity),
      });
      const metadata = await refreshCloudSaveMetadata("main", undefined, game.mode).catch(() => uploaded) ?? uploaded;
      markCloudSaveSynchronized(userId, metadata, localPayload, "main", game.mode);
      setCloudSession((current) => ({ ...current, cloudSave: metadata, cloudSaves: { "1": null, "2": null, "3": null, ...current.cloudSaves, main: metadata } }));
      setUploadRevision((revision) => revision + 1);
      setCloudMessage(`云存档已更新到修订 ${metadata.revision}，排行榜已自动更新`);
      writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", "success", { comparison: "synced", cloud: metadata, lastSuccessfulSyncAt: Date.now(), message: `已提交并确认修订 ${metadata.revision}`, sizes: cloudUploadCapacity ?? initialCapacity }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setCloudUploadErrorCode("ABORTED");
        setCloudMessage("云存档上传已取消；本地存档与云端旧修订均保持不变");
        writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", "cancelled", { comparison: cloudComparison?.state ?? null, cloud: cloudSession.cloudSave, message: "玩家取消上传；本地存档与云端旧修订保持不变", errorCode: "ABORTED", sizes: cloudUploadCapacity ?? initialCapacity }));
        return;
      }
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        setCloudConflict({ slot: "main", localPayload, remote: error.payload.cloudSave as CloudSaveMetadata });
      }
      const described = describeCloudUploadError(error, initialCapacity.originalBytes, cloudUploadCapacity?.compressedBytes ?? null);
      setCloudUploadCapacity(described.capacity ?? cloudUploadCapacity);
      setCloudUploadErrorCode(described.code);
      setCloudMessage(described.message);
      writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", error instanceof CloudApiError && error.status === 409 ? "conflict" : "failed", { comparison: error instanceof CloudApiError && error.status === 409 ? "conflict" : cloudComparison?.state ?? null, cloud: cloudSession.cloudSave, message: described.message, errorCode: described.code, sizes: described.capacity ?? cloudUploadCapacity ?? initialCapacity }));
    } finally {
      if (cloudUploadAbortRef.current === controller) cloudUploadAbortRef.current = null;
      setCloudUploadActive(false);
      setCloudBusy(false);
    }
  };

  const updateCloudSlot = (slot: CloudSaveSlot, metadata: CloudSaveMetadata | null) => {
    setCloudSession((current) => ({
      ...current,
      cloudSave: slot === "main" ? metadata : current.cloudSave,
      cloudSaves: { main: current.cloudSave, "1": null, "2": null, "3": null, ...current.cloudSaves, [slot]: metadata },
    }));
    if (slot === "main") setUploadRevision((revision) => revision + 1);
  };

  const deleteSelectedCloudSave = async () => {
    if (!cloudDeleteRequest || cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const request = cloudDeleteRequest;
    if (request.mode !== game.mode) {
      setCloudDeleteRequest(null);
      setCloudMessage("当前工厂模式已变化，已取消云存档删除");
      return;
    }
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      await deleteCloudSave(request.slot, request.metadata.revision, request.mode);
      clearCloudSyncMarker(cloudSession.user.id, request.slot, request.mode);
      updateCloudSlot(request.slot, null);
      if (request.slot === "main") setCloudHistory([]);
      setCloudDeleteRequest(null);
      setCloudMessage(`${request.label}已删除；另一模式、本地存档和其他云端槽位未受影响`);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : `${request.label}删除失败`);
    } finally {
      setCloudBusy(false);
    }
  };

  const uploadManualCloudSlot = async (slot: Exclude<CloudSaveSlot, "main">) => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const localPayload = await exportGameSlotFromPersistence(Number(slot) as SaveSlotId, game.mode);
    if (!localPayload) {
      setCloudMessage(`本地槽位 ${slot} 为空或校验失败`);
      return;
    }
    const remote = cloudSession.cloudSaves?.[slot] ?? null;
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const comparison = compareCloudSave(cloudSession.user.id, localPayload, remote, slot, game.mode);
      if (remote && ["cloud-newer", "conflict", "unbound"].includes(comparison.state)) {
        setCloudConflict({ slot, localPayload, remote });
        setCloudMessage(`本地槽位 ${slot} 与云端版本不同，请选择保留版本`);
        return;
      }
      const uploaded = await uploadCloudSave(localPayload, remote?.revision ?? 0, slot, { mode: game.mode,
        onStage: (stage) => setCloudMessage(`槽位 ${slot} · ${cloudUploadStageLabel(stage)}`),
      });
      const metadata = await refreshCloudSaveMetadata(slot, undefined, game.mode).catch(() => uploaded) ?? uploaded;
      markCloudSaveSynchronized(cloudSession.user.id, metadata, localPayload, slot, game.mode);
      updateCloudSlot(slot, metadata);
      setCloudMessage(`本地槽位 ${slot} 已上传为云端修订 ${metadata.revision}`);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        setCloudConflict({ slot, localPayload, remote: error.payload.cloudSave as CloudSaveMetadata });
      }
      setCloudMessage(error instanceof Error ? error.message : `云端槽位 ${slot} 上传失败`);
    } finally {
      setCloudBusy(false);
    }
  };

  const downloadManualCloudSlot = async (slot: Exclude<CloudSaveSlot, "main">) => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const remote = cloudSession.cloudSaves?.[slot] ?? null;
    if (!remote) return;
    const localPayload = await exportGameSlotFromPersistence(Number(slot) as SaveSlotId, game.mode);
    const comparison = compareCloudSave(cloudSession.user.id, localPayload, remote, slot, game.mode);
    if (localPayload && comparison.state !== "synced") {
      setCloudConflict({ slot, localPayload, remote });
      setCloudMessage(`槽位 ${slot} 的本地与云端进度不同，请选择版本`);
      return;
    }
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const save = await downloadCloudSave(undefined, slot, game.mode);
      if (!save) throw new Error(`云端槽位 ${slot} 为空`);
      const inspection = inspectSave(save.payload);
      if (!inspection.valid || !inspection.state) throw new Error(inspection.issues[0] ?? "云存档格式无效");
      if (inspection.mode !== game.mode) throw new Error("云端槽位模式与当前工厂不一致，已阻止写入");
      const result = await saveGameSlotVerified(Number(slot) as SaveSlotId, inspection.state);
      if (!result.success) throw new Error(result.message);
      markCloudSaveSynchronized(cloudSession.user.id, save, save.payload, slot, game.mode);
      setLocalSaveSlots(getSaveSlotSummaries(game.mode));
      setCloudMessage(`云端槽位 ${slot} 已下载到对应本地槽位`);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : `云端槽位 ${slot} 下载失败`);
    } finally {
      setCloudBusy(false);
    }
  };

  const prepareCloudRestore = async () => {
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const save = await downloadCloudSave(undefined, "main", game.mode);
      if (!save) setCloudMessage("云端还没有存档");
      else setPendingCloudSave(save);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "云存档下载失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const prepareHistoricalRestore = async (revision: number) => {
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const save = await downloadCloudSave(revision, "main", game.mode);
      if (!save) setCloudMessage(`云端修订 ${revision} 已不可用`);
      else setPendingCloudSave(save);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "历史修订下载失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const makeHistoricalRevisionCurrent = async (revision: number) => {
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const metadata = await restoreCloudSaveRevision(revision, cloudSession.cloudSave?.revision ?? 0, "main", game.mode);
      updateCloudSlot("main", metadata);
      setCloudMessage(`修订 ${revision} 已恢复为新的修订 ${metadata.revision}`);
      writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", "restored", {
        comparison: "cloud-newer",
        cloud: metadata,
        message: `云端修订 ${revision} 已恢复为新修订 ${metadata.revision}；本地存档尚未替换`,
      }));
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        const remote = error.payload.cloudSave as CloudSaveMetadata;
        updateCloudSlot("main", remote);
      }
      setCloudMessage(error instanceof Error ? error.message : "云端历史恢复失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const restorePendingCloudSave = async () => {
    if (!pendingCloudSave) return;
    const result = await onRestoreCloudSave(pendingCloudSave.payload);
    setCloudMessage(result.message);
    if (result.success) {
      if (cloudSession.status === "authenticated" && cloudSession.user) markCloudSaveSynchronized(cloudSession.user.id, pendingCloudSave, pendingCloudSave.payload, "main", game.mode);
      writeCloudSyncStatus(cloudSyncStatusFromUpload(game.mode, "main", "restored", {
        comparison: "synced",
        cloud: pendingCloudSave,
        lastSuccessfulSyncAt: Date.now(),
        message: `已恢复并校验云端修订 ${pendingCloudSave.revision}，恢复前本地快照已保留`,
      }));
      setPendingCloudSave(null);
    }
  };

  const useCloudConflictVersion = async () => {
    if (!cloudConflict || cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const userId = cloudSession.user.id;
    setCloudBusy(true);
    try {
      const cloudSave = await downloadCloudSave(cloudConflict.remote.revision, cloudConflict.slot, game.mode);
      if (!cloudSave) throw new Error("云端修订已不可用，请重新连接后再试");
      const result = cloudConflict.slot === "main"
        ? await onRestoreCloudSave(cloudSave.payload)
        : await (async () => {
            const inspection = inspectSave(cloudSave.payload);
            if (!inspection.valid || !inspection.state) return { success: false, message: inspection.issues[0] ?? "云存档格式无效" };
            if (inspection.mode !== game.mode) return { success: false, message: "冲突云存档模式与当前工厂不一致，已阻止恢复" };
            const saved = await saveGameSlotVerified(Number(cloudConflict.slot) as SaveSlotId, inspection.state);
            if (!saved.success) return { success: false, message: saved.message };
            setLocalSaveSlots(getSaveSlotSummaries(game.mode));
            return { success: true, message: `已在本地槽位 ${cloudConflict.slot} 保留云端版本` };
          })();
      setCloudMessage(result.message);
      if (result.success) {
        markCloudSaveSynchronized(userId, cloudSave, cloudSave.payload, cloudConflict.slot, game.mode);
        updateCloudSlot(cloudConflict.slot, cloudSave);
        setCloudConflict(null);
      }
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "云端版本读取失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const keepLocalConflictVersion = async () => {
    if (!cloudConflict || cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const userId = cloudSession.user.id;
    setCloudBusy(true);
    try {
      const uploaded = await uploadCloudSave(cloudConflict.localPayload, cloudConflict.remote.revision, cloudConflict.slot, { mode: game.mode,
        onStage: (stage) => setCloudMessage(cloudUploadStageLabel(stage)),
      });
      const metadata = await refreshCloudSaveMetadata(cloudConflict.slot, undefined, game.mode).catch(() => uploaded) ?? uploaded;
      markCloudSaveSynchronized(userId, metadata, cloudConflict.localPayload, cloudConflict.slot, game.mode);
      updateCloudSlot(cloudConflict.slot, metadata);
      setCloudConflict(null);
      setCloudMessage(`本地进度已保存为云端修订 ${metadata.revision}`);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        setCloudConflict((current) => current ? { ...current, remote: error.payload.cloudSave as CloudSaveMetadata } : current);
      }
      setCloudMessage(error instanceof Error ? error.message : "本地版本上传失败");
    } finally {
      setCloudBusy(false);
    }
  };

  const submitCurrentSpeedrun = async () => {
    const progress = speedrunSummary?.progress[speedrunTarget];
    const remote = cloudSession.cloudSave;
    if (!speedrunSummary?.eligible || !progress?.completed || cloudSession.status !== "authenticated" || !remote) {
      setSpeedrunMessage("请先完成目标并上传当前速通主云存档，再提交服务端校验");
      return;
    }
    setCloudBusy(true);
    setSpeedrunMessage(null);
    try {
      const result = await submitSpeedrunResult({
        targetId: speedrunTarget,
        seasonId: SPEEDRUN_SEASON_ID,
        rulesetVersion: "speedrun-v1",
        factoryId: game.speedrun?.factoryId ?? "",
        elapsedSeconds: progress.completedAtSeconds ?? speedrunSummary.elapsedActiveSeconds,
        saveRevision: remote.revision,
        saveHash: remote.checksum,
        clientVersion: __APP_VERSION__,
      });
      setSpeedrunEntries((entries) => [result.entry, ...entries.filter((entry) => entry.submissionId !== result.entry.submissionId)]);
      setSpeedrunStatus("ready");
      setSpeedrunMessage(result.idempotent ? "该成绩已提交过，服务端按幂等结果返回" : "速通成绩已通过服务端校验");
    } catch (error) {
      setSpeedrunMessage(error instanceof Error ? error.message : "速通成绩提交失败");
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <WorkspaceFrame className="galaxy-workspace" ariaLabel="银河网络" onRequestClose={onClose}>
      <header className="galaxy-header">
        <div className="galaxy-title">
          <i><Globe2 size={20} /></i>
          <div><span>本地星际档案协议</span><strong>银河网络</strong></div>
        </div>
        <div className="galaxy-node-state" title={cloudSession.message ?? "银河节点连接状态"}>
          <i /><span><strong>{cloudSession.status === "offline" ? "离线节点" : cloudSession.status === "authenticated" ? "云端已登录" : cloudSession.status === "checking" ? "节点校验中" : "公共云节点"}</strong><small>{cloudSession.status === "authenticated" ? `@${cloudSession.user?.username}` : cloudSession.status === "offline" ? "本地节点可继续使用" : "真实排行只读 · 登录后参与"}</small></span>
        </div>
        <div className="galaxy-active-account"><span className="galaxy-avatar galaxy-avatar--small">{account.profile.avatar}</span><span><small>当前账户</small><strong>{account.profile.displayName}</strong></span></div>
        <button className="galaxy-close" type="button" onClick={onClose} title="关闭银河网络" aria-label="关闭银河网络"><X size={18} /></button>
      </header>

      <nav className="galaxy-tabs" aria-label="银河网络页面">
        <button type="button" role="tab" aria-selected={tab === "ranking"} className={tab === "ranking" ? "active" : ""} onClick={() => setTab("ranking")}><Trophy size={15} />银河排行</button>
        <button type="button" role="tab" aria-selected={tab === "speedrun"} className={tab === "speedrun" ? "active" : ""} onClick={() => setTab("speedrun")}><Flag size={15} />速通排行</button>
        <button type="button" role="tab" aria-selected={tab === "cloud"} className={tab === "cloud" ? "active" : ""} onClick={() => setTab("cloud")}>{cloudSession.status === "offline" ? <CloudOff size={15} /> : <Cloud size={15} />}云存档</button>
        <button type="button" role="tab" aria-selected={tab === "account"} className={tab === "account" ? "active" : ""} onClick={() => setTab("account")}><UserRound size={15} />账户</button>
        <span><RadioTower size={13} />{leaderboardStatus === "ready" ? "服务端真实玩家排行榜" : leaderboardStatus === "loading" ? "正在读取真实排行榜" : "云端不可达 · 本地回退"}</span>
      </nav>

      {tab === "ranking" ? (
        <div className="galaxy-ranking-view">
          <section className="galaxy-ranking-toolbar">
            <div className="galaxy-category-tabs" role="tablist" aria-label="排行榜分类">
              {LEADERBOARD_CATEGORIES.map((definition) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={category === definition.id}
                  className={category === definition.id ? "active" : ""}
                  style={{ "--category-color": definition.color } as CSSProperties}
                  onClick={() => setCategory(definition.id)}
                  key={definition.id}
                >
                  {CATEGORY_ICONS[definition.id]}<span><strong>{definition.label}</strong><small>{definition.description}</small></span>
                </button>
              ))}
            </div>
            <label className="galaxy-season-select"><span>排行榜赛季</span><select value={seasonId} onChange={(event) => setSeasonId(event.target.value)} aria-label="排行榜赛季">{LEADERBOARD_SEASONS.map((season) => <option value={season.id} key={season.id}>{season.name}{season.status === "active" ? " · 进行中" : " · 已结束"}</option>)}</select></label>
          </section>

          <section className="galaxy-summary-band">
            <div><span>我的排名</span><strong>{rankLabel}</strong><small title={rankDetail}>{rankDetail}</small></div>
            <div><span>{snapshot.category.label}</span><strong>{categoryValueLabel}{categoryValueForDisplay === null ? null : <small>{snapshot.category.unit}</small>}</strong><small>{serverMetricPending ? "服务器尚无有效指标" : serverCategoryValue !== null ? "服务器认证指标" : snapshot.category.description}</small></div>
            <div><span>银河规模</span><strong>{metrics.exploredSystems}<small>星系</small></strong><small>{metrics.colonizedPlanets} 颗殖民行星</small></div>
            <div><span>节点状态</span><strong className={leaderboardStatus === "ready" ? "positive" : "preview"}>{leaderboardStatus === "ready" ? "真实排行" : leaderboardStatus === "loading" ? "读取中" : "本地回退"}</strong><small>{displayedLocalEntry ? formatTimestamp(displayedLocalEntry.submittedAt) : "--"}</small></div>
          </section>

          <div className="galaxy-ranking-layout">
            <section className="galaxy-leaderboard" aria-label={`${snapshot.category.label}排行榜`}>
              <header><span>排名</span><span>工程组织</span><span>工业规模</span><span>{snapshot.category.label}</span><span>节点记录</span></header>
              <div className="galaxy-leaderboard-rows">
                {leaderboardStatus === "ready" && displayEntries.length === 0 ? <p className="galaxy-leaderboard-empty">本季还没有可公开展示的玩家排名</p> : null}
                {displayEntries.map((entry) => (
                  <article className={`${entry.isLocal ? "galaxy-rank-row--local" : ""}${entry.rank <= 3 ? ` galaxy-rank-row--top-${entry.rank}` : ""}`} key={`${entry.seasonId}:${entry.accountId}`}>
                    <strong className="galaxy-rank-number">{entry.rank <= 3 ? <Crown size={15} /> : null}{String(entry.rank).padStart(2, "0")}</strong>
                    <div className="galaxy-rank-identity"><span className="galaxy-avatar">{entry.avatar}</span><span><strong>{entry.displayName}</strong><small>{entry.isLocal ? "当前账户" : leaderboardStatus === "ready" ? "真实玩家" : "本地模拟样本"}</small></span></div>
                    <span className="galaxy-rank-footprint"><strong>{entry.metrics.exploredSystems} 星系 · {entry.metrics.colonizedPlanets} 行星</strong><small>峰值发电 <PowerValue valueKw={entry.metrics.peakGenerationKw} /></small></span>
                    <strong className="galaxy-rank-value" title={`${formatQuantityExact(Math.floor(entry.value))}${snapshot.category.unit ? ` ${snapshot.category.unit}` : category === "dyson" ? " kW" : ""}`}>{formatLeaderboardValue(entry.value, category)}<small>{snapshot.category.unit}</small></strong>
                    <span className={`galaxy-rank-status${entry.isLocal && !entry.submitted ? " galaxy-rank-status--preview" : ""}`}>{entry.verified ? <ShieldCheck size={13} /> : <Activity size={13} />}{leaderboardStatus === "ready" ? "主云存档计算" : entry.accountId.startsWith("npc_") ? "模拟基准" : "本地记录"}</span>
                  </article>
                ))}
              </div>
            </section>

            <aside className="galaxy-upload-panel">
              <header><span className="galaxy-avatar galaxy-avatar--large">{account.profile.avatar}</span><div><small>本季个人档案</small><strong>{cloudSession.user?.displayName ?? account.profile.displayName}</strong><span>{leaderboardVisible ? <><Eye size={12} />公开排名</> : <><EyeOff size={12} />已退出排行榜</>}</span></div></header>
              <dl>
                <div><dt>累计发电</dt><dd>{formatMetric(metrics.energyGeneratedMj, 1)} <small>MJ</small></dd></div>
                <div><dt>白矩阵上传</dt><dd>{formatMetric(metrics.uploadedWhiteMatrix)} <small>份</small></dd></div>
                <div><dt>服务器白糖产量峰值</dt><dd>{serverWhiteValue === null ? "--" : formatMetric(serverWhiteValue, 1)} {serverWhiteValue === null ? null : <small>/min</small>}</dd></div>
                <div><dt>本地 60 秒白糖最佳</dt><dd>-- <small>本地尚未记录</small></dd></div>
                <div><dt>戴森峰值</dt><dd><PowerValue valueKw={metrics.peakDysonPowerKw} /></dd></div>
                <div><dt>服务器实际结算吞吐</dt><dd>{serverThroughputValue === null ? "--" : formatMetric(serverThroughputValue, 1)} {serverThroughputValue === null ? null : <small>/min</small>}</dd></div>
                <div><dt>本地 60 秒实际结算吞吐最佳</dt><dd>{formatMetric(metrics.peakThroughputPerMinute, 1)} <small>/min</small></dd></div>
                <div><dt>当前星球理论速率</dt><dd>{formatMetric(activePlanetThroughput, 1)} <small>/min</small></dd></div>
                <div><dt>全星区理论速率</dt><dd>{formatMetric(galacticThroughput, 1)} <small>/min</small></dd></div>
                <div><dt>全星区理论峰值</dt><dd>{formatMetric(serverMetrics?.theoreticalPeakThroughputPerMinute ?? metrics.theoreticalPeakThroughputPerMinute ?? 0, 1)} <small>/min</small></dd></div>
              </dl>
              <button
                className={`galaxy-upload-command galaxy-upload-command--${uploadState}`}
                type="button"
                disabled={snapshot.season.status === "ended" || !cloudLeaderboardEligible}
                onClick={() => void upload()}
              >
                {uploadState === "success" ? <Check size={15} /> : !leaderboardVisible ? <LockKeyhole size={15} /> : <Send size={15} />}
                {uploadState === "success" ? "排名已刷新" : !leaderboardVisible ? "已退出公开排行榜" : snapshot.season.status === "ended" ? "历史赛季已封存" : cloudSession.status !== "authenticated" ? "登录后刷新排名" : !cloudSession.cloudSave ? "先上传主云存档" : "立即刷新排名"}
              </button>
              {cloudSession.status === "authenticated" && game.mode === "normal" ? <button className="galaxy-upload-command" type="button" disabled={cloudBusy} onClick={() => void saveCurrentFactoryToCloud()}><Cloud size={15} />立即同步普通主存档</button> : null}
              {cloudSession.status === "authenticated" ? <label className="galaxy-leaderboard-visibility"><span><strong>{leaderboardVisible ? "参与公开排行榜" : "已退出排行榜"}</strong><small>{leaderboardVisible ? "主云存档同步成功后自动更新排名" : "后续同步不会重新加入，可随时恢复"}</small></span><input type="checkbox" checked={leaderboardVisible} disabled={leaderboardVisibilityBusy} onChange={(event) => void updateLeaderboardVisibility(event.target.checked)} aria-label="参与公开排行榜" /></label> : null}
              {leaderboardError ? <p className="galaxy-leaderboard-error" role="alert"><CloudOff size={13} /><span>{leaderboardError}</span></p> : null}
              {statusMessage ? <p><LockKeyhole size={13} /><span>{statusMessage}</span></p> : null}
              {metricWindowMessage ? <p>{category === "white-rate" ? <Gauge size={13} /> : <Factory size={13} />}<span>{metricWindowMessage}</span></p> : null}
              {localServerMetricMessage ? <p><History size={13} /><span>{localServerMetricMessage}</span></p> : null}
              {nominalThroughputMetricVersion === "legacy-active-planet-v1" ? <p><History size={13} /><span>该记录缺少完整行星指标，理论速率暂按旧存档的当前星球口径显示；实际结算吞吐不受此回退影响。</span></p> : null}
              <p><Database size={13} /><span>当前认证数据源：{leaderboardSourceLabel}。速通主槽和手动槽不会更新银河榜。</span></p>
              <p><RadioTower size={13} /><span>{cloudSession.status === "authenticated" ? cloudSession.cloudSave ? "主云存档上传和十分钟自动同步成功后，服务端会自动更新排名。" : "请先上传当前主云存档；手动槽位不会加入排行榜。" : "访客可查看真实玩家排名；登录并上传主云存档后自动参与。"}</span></p>
            </aside>
          </div>
        </div>
      ) : tab === "speedrun" ? (
        <div className="galaxy-speedrun-view">
          <section className="galaxy-ranking-toolbar">
            <div className="galaxy-category-tabs" role="tablist" aria-label="速通目标">
              {SPEEDRUN_TARGET_IDS.map((targetId) => {
                const target = SPEEDRUN_TARGETS[targetId];
                return <button type="button" role="tab" aria-selected={speedrunTarget === targetId} className={speedrunTarget === targetId ? "active" : ""} onClick={() => setSpeedrunTarget(targetId)} key={targetId}><Flag size={15} /><span><strong>{target.label}</strong><small>{target.description}</small></span></button>;
              })}
            </div>
            <label className="galaxy-season-select"><span>速通赛季</span><select value={SPEEDRUN_SEASON_ID} disabled aria-label="速通赛季"><option value={SPEEDRUN_SEASON_ID}>{SPEEDRUN_SEASON_ID} · 规则 speedrun-v1</option></select></label>
          </section>
          <section className="galaxy-summary-band">
            <div><span>当前工厂</span><strong>{speedrunSummary ? formatSpeedrunDuration(speedrunSummary.elapsedActiveSeconds) : "普通工厂"}</strong><small>{speedrunSummary?.eligible ? "可提交服务端校验" : "普通工厂不具备速通资格"}</small></div>
            <div><span>目标进度</span><strong>{speedrunSummary ? `${speedrunSummary.progress[speedrunTarget].current.toLocaleString("zh-CN")}/${speedrunSummary.progress[speedrunTarget].target.toLocaleString("zh-CN")}` : "--"}</strong><small>{SPEEDRUN_TARGETS[speedrunTarget].label}</small></div>
            <div><span>我的最好成绩</span><strong>{speedrunEntries.find((entry) => entry.userId === ownSpeedrunPublicId)?.elapsedSeconds ? formatSpeedrunDuration(speedrunEntries.find((entry) => entry.userId === ownSpeedrunPublicId)!.elapsedSeconds) : "未上榜"}</strong><small>仅显示已验证成绩</small></div>
            <div><span>资格</span><strong className={speedrunSummary?.eligible ? "positive" : "preview"}>{speedrunSummary?.eligible ? "已具备" : "未验证"}</strong><small>{speedrunSummary?.invalidReason ?? "服务端提交后才会进入正式排名"}</small></div>
          </section>
          <div className="galaxy-ranking-layout">
            <section className="galaxy-leaderboard" aria-label="速通排行榜">
              <header><span>排名</span><span>工程师</span><span>完成用时</span><span>完成日期</span><span>状态</span></header>
              <div className="galaxy-leaderboard-rows">
                {speedrunStatus === "loading" ? <p className="galaxy-leaderboard-empty">正在读取速通排行榜…</p> : null}
                {speedrunStatus === "ready" && speedrunEntries.length === 0 ? <p className="galaxy-leaderboard-empty">本赛季还没有已验证成绩</p> : null}
                {speedrunEntries.map((entry) => <article className={entry.userId === ownSpeedrunPublicId ? "galaxy-rank-row--local" : ""} key={entry.submissionId}><strong className="galaxy-rank-number">{entry.rank}</strong><div className="galaxy-rank-identity"><span className="galaxy-avatar">{entry.avatar}</span><span><strong>{entry.displayName}</strong><small>{entry.userId === ownSpeedrunPublicId ? "当前账户" : "已验证玩家"}</small></span></div><strong className="galaxy-rank-value">{formatSpeedrunDuration(entry.elapsedSeconds)}</strong><span>{new Date(entry.completedAt).toLocaleDateString("zh-CN")}</span><span className="galaxy-rank-status"><ShieldCheck size={13} />已验证{entry.resourceMode === "infinite" ? " · 无限矿物" : ""}</span></article>)}
              </div>
            </section>
            <aside className="galaxy-upload-panel">
              <header><Trophy size={20} /><div><small>速通成绩</small><strong>{speedrunSummary ? SPEEDRUN_TARGETS[speedrunTarget].label : "普通工厂"}</strong></div></header>
              <p>速通排行榜与普通银河排行完全隔离。客户端成绩仅在服务端核对云存档修订、工厂身份和真实生产统计后生效。</p>
              <button className="galaxy-upload-command" type="button" disabled={cloudBusy || !speedrunSummary?.eligible || !speedrunSummary.progress[speedrunTarget].completed || cloudSession.status !== "authenticated" || !cloudSession.cloudSave} onClick={() => void submitCurrentSpeedrun()}><Send size={15} />提交当前成绩</button>
              {speedrunMessage ? <p className="galaxy-leaderboard-error" role="status"><Activity size={13} /><span>{speedrunMessage}</span></p> : null}
            </aside>
          </div>
        </div>
      ) : tab === "cloud" ? (
        <div className="galaxy-cloud-view">
          <section className="galaxy-cloud-status">
            <header>
              <i>{cloudSession.status === "offline" ? <CloudOff size={22} /> : <Cloud size={22} />}</i>
              <span><small>DSP 极简网络云节点</small><strong>{cloudSession.status === "authenticated" ? cloudSession.user?.displayName : cloudSession.status === "offline" ? "当前离线" : cloudSession.status === "checking" ? "正在连接" : "登录云账户"}</strong></span>
              <em className={`cloud-state cloud-state--${cloudSession.status}`}>{cloudSession.status === "authenticated" ? "已登录" : cloudSession.status === "anonymous" ? "访客" : cloudSession.status === "checking" ? "连接中" : "离线"}</em>
            </header>
            {cloudSession.status === "offline" ? <div className="galaxy-cloud-offline"><CloudOff size={24} /><span><strong>云服务暂时不可达</strong><small>{cloudSession.message ?? "本地存档和本地排行榜仍可继续使用。"}</small></span><button type="button" onClick={() => { setCloudSession({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null }); void resumeCloudSession(game.mode).then(setCloudSession); }}>重新连接</button></div> : null}
            {cloudSession.status === "anonymous" ? <form className="galaxy-cloud-auth" onSubmit={(event) => { event.preventDefault(); void authenticateCloud(); }}>
              <div className="galaxy-cloud-auth-mode"><button className={cloudMode === "login" ? "active" : ""} type="button" onClick={() => setCloudMode("login")}>登录</button><button className={cloudMode === "register" ? "active" : ""} type="button" onClick={() => setCloudMode("register")}>注册</button></div>
              {!cloudMailAvailable ? <p className="galaxy-cloud-development"><CloudOff size={14} /><span>邮件系统尚未开放。用户名注册、全部云存档、自动同步和排行榜均可使用；找回密码暂不可用。</span></p> : null}
              {cloudMode === "register" ? <label><span>显示名称</span><StableTextInput draftId="galaxy-cloud-display-name" value={cloudDisplayName} onValueChange={setCloudDisplayName} maxLength={24} placeholder={account.profile.displayName} autoComplete="nickname" /></label> : null}
              <label><span>{cloudMode === "register" ? "用户名" : "用户名或邮箱"}</span><StableTextInput draftId="galaxy-cloud-identifier" type="text" value={cloudIdentifier} onValueChange={setCloudIdentifier} minLength={cloudMode === "register" ? 4 : undefined} maxLength={cloudMode === "register" ? 24 : 254} pattern={cloudMode === "register" ? "[A-Za-z0-9_]{4,24}" : undefined} title={cloudMode === "register" ? "4 至 24 位英文字母、数字或下划线" : undefined} required autoComplete="username" placeholder={cloudMode === "register" ? "4-24 位字母、数字或下划线" : "用户名或已绑定邮箱"} /></label>
              <label><span>密码</span><StableTextInput draftId="galaxy-cloud-password" sensitive type="password" value={cloudPassword} onValueChange={setCloudPassword} minLength={8} maxLength={128} required autoComplete={cloudMode === "register" ? "new-password" : "current-password"} placeholder="至少 8 位" /></label>
              <button className="primary" type="submit" disabled={cloudBusy}>{cloudBusy ? <Activity size={15} /> : <LogIn size={15} />}{cloudMode === "register" ? "创建并登录" : "登录云账户"}</button>
            </form> : null}
            {cloudSession.status === "authenticated" && cloudSession.user ? <div className="galaxy-cloud-account">
              <div className="galaxy-cloud-identity"><span className="galaxy-avatar galaxy-avatar--large">{cloudSession.user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{cloudSession.user.displayName}</strong><small>@{cloudSession.user.username}{cloudSession.user.email ? ` · ${cloudSession.user.email}` : ""} · {account.profile.cloudUserId === cloudSession.user.id ? "已绑定当前本地身份" : "尚未绑定当前本地身份"}</small></span><div className="galaxy-cloud-identity-actions"><button type="button" onClick={() => onUpdateCloudBinding(account.profile.cloudUserId === cloudSession.user!.id ? null : { id: cloudSession.user!.id, email: cloudSession.user!.email || `@${cloudSession.user!.username}` })}>{account.profile.cloudUserId === cloudSession.user.id ? <Unlink size={14} /> : <Link2 size={14} />}{account.profile.cloudUserId === cloudSession.user.id ? "解除绑定" : "绑定本地身份"}</button><button type="button" onClick={() => { setCloudBusy(true); void logoutCloudAccount().then(() => { setCloudSession((current) => ({ status: "anonymous", user: null, cloudSave: null, mailAvailable: current.mailAvailable, message: null })); setCloudEntries([]); }).finally(() => setCloudBusy(false)); }}><LogOut size={14} />退出</button></div></div>
              <div className="galaxy-cloud-save-card">
                <header><Save size={18} /><span><small>{game.mode === "speedrun" ? "速通模式" : "普通模式"} · 当前主存档</small><strong>{cloudSession.cloudSave ? `修订 ${cloudSession.cloudSave.revision}` : "尚未上传"}</strong></span><em>{cloudSession.cloudSave ? `${(cloudSession.cloudSave.size / 1024).toFixed(1)} KB` : "--"}</em></header>
                {cloudComparison ? <p className={`cloud-sync-state cloud-sync-state--${cloudComparison.state}`}>{cloudSyncLabel(cloudComparison.state)}</p> : null}
                <dl><div><dt>更新时间</dt><dd>{cloudSession.cloudSave ? new Date(cloudSession.cloudSave.updatedAt).toLocaleString("zh-CN") : "--"}</dd></div><div><dt>校验摘要</dt><dd>{cloudSession.cloudSave?.checksum.slice(0, 12) ?? "--"}</dd></div><div><dt>本地进度</dt><dd>{cloudComparison?.local ? `${Math.floor(cloudComparison.local.elapsedSeconds / 3600)}h · 科技 ${cloudComparison.local.completedTechCount}` : "--"}</dd></div><div><dt>云端进度</dt><dd>{cloudSession.cloudSave?.summary ? `${Math.floor(cloudSession.cloudSave.summary.elapsedSeconds / 3600)}h · 科技 ${cloudSession.cloudSave.summary.completedTechCount}` : "--"}</dd></div></dl>
                <div><button type="button" disabled={cloudBusy} onClick={() => void prepareCloudRestore()}><Download size={14} />下载到本机</button><button className="primary" type="button" disabled={cloudBusy} onClick={() => void saveCurrentFactoryToCloud()}><Save size={14} />上传当前存档</button><button className="danger" type="button" disabled={cloudBusy || !cloudSession.cloudSave} onClick={() => cloudSession.cloudSave && setCloudDeleteRequest({ slot: "main", mode: game.mode, metadata: cloudSession.cloudSave, scope: "cloud", label: `${game.mode === "speedrun" ? "速通模式" : "普通模式"}云端主存档`, details: `修订 ${cloudSession.cloudSave.revision} · ${new Date(cloudSession.cloudSave.updatedAt).toLocaleString("zh-CN")}` })}><Trash2 size={14} />删除云存档</button></div>
                <CloudSaveStatusCenter userId={cloudSession.user.id} mode={game.mode} slot="main" localRevision={getPrimaryLocalSaveRevision(game.mode)} cloud={cloudSession.cloudSave} comparison={cloudComparison?.state ?? null} active={cloudUploadActive} message={cloudMessage} errorCode={cloudUploadErrorCode} capacity={cloudUploadCapacity} onRetry={() => void saveCurrentFactoryToCloud()} onCancel={cloudUploadActive ? () => cloudUploadAbortRef.current?.abort() : undefined} onExportLocal={() => void exportTextFile({ contents: localCloudPayload ?? exportGame(game), fileName: `dsp-idle-${game.mode}-local-${new Date().toISOString().slice(0, 10)}.json`, title: "导出本地主存档副本" })} onExportCloud={cloudSession.cloudSave ? () => void downloadCloudSave(undefined, "main", game.mode).then((save) => save && exportTextFile({ contents: save.payload, fileName: `dsp-idle-${game.mode}-cloud-r${save.revision}.json`, title: "导出云端主存档副本" })).catch((error) => setCloudMessage(error instanceof Error ? error.message : "云端副本导出失败")) : undefined} />
              </div>
              <CloudSaveSlotsPanel mode={game.mode} cloudSaves={cloudSession.cloudSaves} localSlots={localSaveSlots} busySlot={cloudBusy ? "main" : null} uploadDisabled={false} onUpload={(slot) => void uploadManualCloudSlot(slot)} onDownload={(slot) => void downloadManualCloudSlot(slot)} onDelete={(slot, metadata) => setCloudDeleteRequest({ slot, mode: game.mode, metadata, scope: "cloud", label: `${game.mode === "speedrun" ? "速通模式" : "普通模式"}云端槽位 ${slot}`, details: `修订 ${metadata.revision} · ${new Date(metadata.updatedAt).toLocaleString("zh-CN")}` })} />
              {cloudHistory.length > 0 ? <section className="galaxy-cloud-history" aria-label="云存档历史修订">
                <header><History size={15} /><span>历史修订</span><strong>{cloudHistory.length}/{20}</strong></header>
                <div>{cloudHistory.map((entry) => <article className={entry.revision === cloudSession.cloudSave?.revision ? "active" : ""} key={entry.revision}>
                  <span><strong>修订 {entry.revision}</strong><small>{new Date(entry.updatedAt).toLocaleString("zh-CN")}{entry.restoredFromRevision ? ` · 来自修订 ${entry.restoredFromRevision}` : ""}</small></span>
                  <em>{(entry.size / 1024).toFixed(1)} KB</em>
                  <button type="button" disabled={cloudBusy} onClick={() => void prepareHistoricalRestore(entry.revision)} title={`下载修订 ${entry.revision}`} aria-label={`下载云存档修订 ${entry.revision}`}><Download size={13} /></button>
                  <button type="button" disabled={cloudBusy || entry.revision === cloudSession.cloudSave?.revision} onClick={() => void makeHistoricalRevisionCurrent(entry.revision)} title={`把修订 ${entry.revision} 恢复为当前版本`} aria-label={`恢复云存档修订 ${entry.revision}`}><RotateCcw size={13} /></button>
                </article>)}</div>
              </section> : null}
              <CloudAccountSecurity user={cloudSession.user} mailAvailable={cloudMailAvailable} onUserChange={(user) => setCloudSession((current) => ({ ...current, user }))} onLoggedOut={() => { setCloudSession((current) => ({ status: "anonymous", user: null, cloudSave: null, mailAvailable: current.mailAvailable, message: null })); setCloudEntries([]); }} />
            </div> : null}
            {cloudMessage ? <p className="galaxy-cloud-message" role="status">{cloudMessage}</p> : null}
          </section>
          <aside className="galaxy-cloud-policy"><ShieldCheck size={20} /><span><strong>冲突与校验</strong><small>每次上传都携带云端修订号；另一台设备先更新后，本机不会静默覆盖。恢复云存档前会保留当前工厂快照。</small></span></aside>
          {pendingCloudSave ? <div className="galaxy-cloud-confirm"><section role="alertdialog" aria-modal="true" aria-label="确认恢复云存档"><header><Download size={18} /><span><strong>恢复{game.mode === "speedrun" ? "速通模式" : "普通模式"}云存档修订 {pendingCloudSave.revision}</strong><small>{new Date(pendingCloudSave.updatedAt).toLocaleString("zh-CN")}</small></span></header><p>只会替换当前模式工厂，并先创建同模式本地回滚快照；另一模式不会受到影响。</p><footer><button type="button" onClick={() => setPendingCloudSave(null)}>取消</button><button className="primary" type="button" onClick={restorePendingCloudSave}>确认恢复</button></footer></section></div> : null}
          {cloudConflict ? <CloudSaveConflictDialog local={summarizeCloudPayload(cloudConflict.localPayload)} cloud={cloudConflict.remote} slot={cloudConflict.slot} busy={cloudBusy} onUseCloud={() => void useCloudConflictVersion()} onKeepLocal={() => void keepLocalConflictVersion()} onExportLocal={() => void exportTextFile({ contents: cloudConflict.localPayload, fileName: `dsp-idle-${game.mode}-${cloudConflict.slot}-local-conflict.json`, title: "导出冲突本地副本" })} onExportCloud={() => void downloadCloudSave(cloudConflict.remote.revision, cloudConflict.slot, game.mode).then((save) => save && exportTextFile({ contents: save.payload, fileName: `dsp-idle-${game.mode}-${cloudConflict.slot}-cloud-r${save.revision}.json`, title: "导出冲突云端副本" })).catch((error) => setCloudMessage(error instanceof Error ? error.message : "冲突云端副本导出失败"))} onCancel={() => setCloudConflict(null)} /> : null}
          <SaveDeleteDialog target={cloudDeleteRequest} onCancel={() => setCloudDeleteRequest(null)} onDelete={() => void deleteSelectedCloudSave()} />
        </div>
      ) : (
        <div className="galaxy-account-view">
          <aside className="galaxy-account-list">
            <header><span><Users size={15} />本地账户</span><strong>{Object.keys(accountState.accounts).length}</strong></header>
            <div>{Object.values(accountState.accounts).map((record) => <button type="button" className={record.profile.id === account.profile.id ? "active" : ""} onClick={() => onSwitchAccount(record.profile.id)} key={record.profile.id}><span className="galaxy-avatar">{record.profile.avatar}</span><span><strong>{record.profile.displayName}</strong><small>{record.profile.privacy === "public" ? "公开" : "隐私"} · 综合 {formatMetric(getLeaderboardMetrics(record.ledger).galaxyScore)}</small></span>{record.profile.id === account.profile.id ? <Check size={14} /> : null}</button>)}</div>
            <form onSubmit={(event) => { event.preventDefault(); const name = newAccountName.trim(); onCreateAccount(name || `星际工程师 ${Object.keys(accountState.accounts).length + 1}`); setNewAccountName(""); clearStableTextDraft("galaxy-new-local-account"); }}>
              <StableTextInput draftId="galaxy-new-local-account" value={newAccountName} onValueChange={setNewAccountName} maxLength={24} placeholder="新账户名称" aria-label="新账户名称" />
              <button type="submit" title="创建本地账户" aria-label="创建本地账户"><Plus size={15} /></button>
            </form>
          </aside>

          <section className="galaxy-profile-editor">
            <header><div><UserRound size={18} /><span><small>账户设置</small><strong>星际工程师档案</strong></span></div><span><RadioTower size={13} />{account.profile.cloudUserId ? `已绑定 ${account.profile.cloudEmail ?? "云账号"}` : "本地身份 · 尚未绑定云账号"}</span></header>
            <form onSubmit={(event) => { event.preventDefault(); onUpdateProfile({ displayName: nameDraft }); }}>
              <label className="galaxy-name-field"><span>显示名称</span><div><StableTextInput draftId={`galaxy-profile-${account.profile.id}`} value={nameDraft} onValueChange={setNameDraft} maxLength={24} aria-label="账户显示名称" /><button type="submit" onClick={() => clearStableTextDraft(`galaxy-profile-${account.profile.id}`)}>保存名称</button></div><small>公开账户上传后会以此名称出现在银河排行。</small></label>
              <fieldset className="galaxy-avatar-picker"><legend>账户识别标记</legend><div>{ACCOUNT_AVATARS.map((avatar, index) => <button type="button" aria-pressed={account.profile.avatar === avatar} className={account.profile.avatar === avatar ? "active" : ""} style={{ "--avatar-index": index } as CSSProperties} onClick={() => onUpdateProfile({ avatar })} key={avatar}><span>{avatar}</span></button>)}</div></fieldset>
              <label className="galaxy-privacy-setting"><span className="galaxy-privacy-icon">{leaderboardVisible ? <Eye size={18} /> : <EyeOff size={18} />}</span><span><strong>{leaderboardVisible ? "参与公开排行榜" : "已退出排行榜"}</strong><small>{cloudSession.status === "authenticated" ? leaderboardVisible ? "主云存档同步后由服务端自动更新公开排名" : "公开记录已移除，云存档仍正常同步" : "登录云账号后可设置账号级排行榜参与状态"}</small></span><input type="checkbox" checked={leaderboardVisible} disabled={leaderboardVisibilityBusy} onChange={(event) => void updateLeaderboardVisibility(event.target.checked)} aria-label="参与公开排行榜" /><i aria-hidden="true"><b /></i></label>
            </form>

            <section className="galaxy-ledger-section">
              <header><span><BarChart3 size={15} />账户工业账本</span><small>切换账户不会切换当前工厂存档</small></header>
              <div>
                <article><Zap size={18} /><span>累计发电<strong>{formatMetric(metrics.energyGeneratedMj, 1)} <small>MJ</small></strong></span></article>
                <article><Database size={18} /><span>白矩阵上传<strong>{formatMetric(metrics.uploadedWhiteMatrix)} <small>份</small></strong></span></article>
                <article><Orbit size={18} /><span>戴森峰值<strong><PowerValue valueKw={metrics.peakDysonPowerKw} /></strong></span></article>
                <article><Gauge size={18} /><span>本地 60 秒实际结算吞吐最佳<strong>{formatMetric(metrics.peakThroughputPerMinute, 1)} <small>/min</small></strong></span></article>
                <article><Factory size={18} /><span>全星区理论峰值<strong>{formatMetric(metrics.theoreticalPeakThroughputPerMinute ?? 0, 1)} <small>/min</small></strong></span></article>
                <article><Globe2 size={18} /><span>星际版图<strong>{metrics.exploredSystems} <small>星系</small> · {metrics.colonizedPlanets} <small>行星</small></strong></span></article>
                <article><Trophy size={18} /><span>银河综合<strong>{formatMetric(metrics.galaxyScore)} <small>分</small></strong></span></article>
              </div>
            </section>

            <footer className="galaxy-account-notice"><ShieldCheck size={16} /><span><strong>存档边界</strong><small>账户档案与工厂存档分别保存。重置工厂不会删除账户或累计排行榜账本。</small></span></footer>
          </section>
        </div>
      )}
    </WorkspaceFrame>
  );
}
