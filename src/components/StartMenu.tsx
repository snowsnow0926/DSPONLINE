import { useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  Clock3,
  Cloud,
  CloudOff,
  Cpu,
  Database,
  Download,
  Factory,
  FileUp,
  Gauge,
  HardDrive,
  History,
  Languages,
  LogIn,
  LogOut,
  MailWarning,
  MessageCircle,
  MousePointer2,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  SkipForward,
  ShieldCheck,
  Type,
  Trash2,
  Upload,
  UserPlus,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { QuantityValue } from "./QuantityValue";
import {
  CloudApiError,
  compareCloudSave,
  compareCloudSaveSummary,
  downloadCloudSave,
  loginCloudAccount,
  logoutCloudAccount,
  markCloudSaveSynchronized,
  registerCloudAccount,
  requestCloudPasswordReset,
  resetCloudPassword,
  resumeCloudSession,
  refreshCloudSaveMetadata,
  summarizeCloudPayload,
  uploadCloudSave,
  uploadCloudSaveWithOptions,
  verifyCloudEmail,
  type CloudSaveMetadata,
  type CloudSaveSlot,
  type CloudSyncState,
  type CloudSession,
  type CloudUploadStage,
} from "../game/cloud";
import { trackAnalyticsEvent } from "../game/analytics";
import { getMenuContinueSave, getMenuPlanetName, getMenuSlotSummaries, getMenuSnapshotSummaries, type MenuContinueSave, type MenuSaveSource } from "../game/savePreview";
import type { DeferredLoadedGame, LoadedGame, SaveInspection, SaveSlotId } from "../game/storage";
import type { AutosaveIntervalSeconds, FontScale, GameSettings, SimulationSpeed } from "../game/types";
import { getDesktopBridge } from "../desktop";
import { CURRENT_RELEASE_NOTES } from "./ReleaseNotesDialog";
import { importWithRecovery } from "../game/dynamicImportRecovery";
import { NativeUpdateCard } from "./NativeUpdateCard";
import { NATIVE_BACK_EVENT } from "../nativeApp";
import { CloudAccountSecurity } from "./CloudAccountSecurity";
import { CloudSaveConflictDialog } from "./CloudSaveConflictDialog";
import { CloudSaveSlotsPanel } from "./CloudSaveSlotsPanel";
import { SaveDeleteDialog, type SaveDeleteTarget } from "./SaveDeleteDialog";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { isSecureCloudClient } from "../nativeApp";
import { useAppLocale } from "../i18n/locale";
import { exportTextFile } from "../game/fileExport";
import {
  isApproximateOfflineExperimentEnabled,
  offlineSettlementPhaseLabel,
  setApproximateOfflineExperimentEnabled,
  type OfflineSettlementDiagnostics,
  type OfflineSettlementPhase,
} from "../game/offlineExperiment";

type StartMenuView = "overview" | "saves" | "cloud" | "import" | "settings" | "new";
type CloudAuthMode = "login" | "register" | "forgot" | "reset";
type MenuMessage = { tone: "busy" | "ready" | "warning" | "error"; text: string } | null;
type OfflineLoadProgress = {
  label: string;
  completedSeconds: number;
  totalSeconds: number;
  progress: number;
  phase?: OfflineSettlementPhase;
  approximateSeconds?: number;
  estimatedError?: number;
};

function cloudUploadStageLabel(stage: CloudUploadStage): string {
  if (stage === "compressing") return "压缩存档";
  if (stage === "sending") return "发送云端";
  return "等待服务器确认";
}

const MENU_SETTINGS_KEY = "dsp-idle-network.menu-settings.v1";
const REGISTRATION_DRAFT_KEY = "dsp-idle-network.registration-draft.v1";
const NATIVE_DOWNLOAD_URL = "https://download.dsponline.cn/";
const FONT_SCALES: FontScale[] = [0.8, 1, 1.25, 1.5, 2];
const SIMULATION_SPEEDS: SimulationSpeed[] = [1, 2, 4];
const AUTOSAVE_INTERVALS: AutosaveIntervalSeconds[] = [30, 60, 120];
const DEFAULT_MENU_SETTINGS: GameSettings = {
  simulationSpeed: 1,
  fontScale: 1,
  theme: "dark",
  technologyLayout: "standard",
  performanceMode: false,
  reducedMotion: false,
  soundEnabled: false,
  allowDoubleClickZoom: false,
  beltHeatmapEnabled: false,
  defaultBeltStackSize: 1,
  defaultBeltRouteMode: "auto",
  productionBufferLimit: 1_000_000,
  logisticsBufferLimit: 1_000_000,
  beltBufferLimit: 100_000_000,
  proliferatorBufferLimit: 600,
  autosaveIntervalSeconds: 30,
  resourceMode: "finite",
  difficulty: "standard",
};
const loadStorageModule = async () => {
  const contentPacks = await importWithRecovery(() => import("../game/contentPacks"), "内容包注册表");
  contentPacks.applyContentPackRegistry(contentPacks.loadContentPackRegistry());
  return importWithRecovery(() => import("../game/storage"), "本地存档模块");
};
type StorageModule = Awaited<ReturnType<typeof loadStorageModule>>;

interface StartMenuProps {
  onEnterGame: (loaded: LoadedGame) => void;
  onOpenReleaseNotes: () => void;
}

function formatRuntime(seconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function formatSavedAt(savedAt: number | null | undefined): string {
  if (!savedAt) return "尚未保存";
  return new Date(savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function cloudSyncLabel(state: CloudSyncState): string {
  if (state === "synced") return "本地与云端一致";
  if (state === "local-newer" || state === "local-only") return "本地有待上传进度";
  if (state === "cloud-newer" || state === "cloud-only") return "其他设备有云端更新";
  if (state === "conflict" || state === "unbound") return "需要选择保留版本";
  return "尚未建立云存档";
}

function readMenuSettings(fallback: GameSettings): GameSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MENU_SETTINGS_KEY) ?? "null") as Partial<GameSettings> | null;
    if (!parsed) return fallback;
    return {
      ...fallback,
      simulationSpeed: SIMULATION_SPEEDS.includes(parsed.simulationSpeed as SimulationSpeed) ? parsed.simulationSpeed as SimulationSpeed : fallback.simulationSpeed,
      fontScale: FONT_SCALES.includes(parsed.fontScale as FontScale) ? parsed.fontScale as FontScale : fallback.fontScale,
      theme: parsed.theme === "light" || parsed.theme === "system" ? parsed.theme : "dark",
      technologyLayout: parsed.technologyLayout === "compact" ? "compact" : "standard",
      autosaveIntervalSeconds: AUTOSAVE_INTERVALS.includes(parsed.autosaveIntervalSeconds as AutosaveIntervalSeconds) ? parsed.autosaveIntervalSeconds as AutosaveIntervalSeconds : fallback.autosaveIntervalSeconds,
      performanceMode: typeof parsed.performanceMode === "boolean" ? parsed.performanceMode : fallback.performanceMode,
      reducedMotion: typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : fallback.reducedMotion,
      soundEnabled: typeof parsed.soundEnabled === "boolean" ? parsed.soundEnabled : fallback.soundEnabled,
      allowDoubleClickZoom: typeof parsed.allowDoubleClickZoom === "boolean" ? parsed.allowDoubleClickZoom : fallback.allowDoubleClickZoom,
      defaultBeltStackSize: parsed.defaultBeltStackSize === 2 || parsed.defaultBeltStackSize === 4 ? parsed.defaultBeltStackSize : 1,
      defaultBeltRouteMode: parsed.defaultBeltRouteMode === "bezier" || parsed.defaultBeltRouteMode === "upper" || parsed.defaultBeltRouteMode === "lower" ? parsed.defaultBeltRouteMode : "auto",
      productionBufferLimit: Number.isInteger(parsed.productionBufferLimit) && parsed.productionBufferLimit! >= 1_000 && parsed.productionBufferLimit! <= 100_000_000 ? parsed.productionBufferLimit! : fallback.productionBufferLimit,
      logisticsBufferLimit: Number.isInteger(parsed.logisticsBufferLimit) && parsed.logisticsBufferLimit! >= 1_000 && parsed.logisticsBufferLimit! <= 100_000_000 ? parsed.logisticsBufferLimit! : fallback.logisticsBufferLimit,
    };
  } catch {
    return fallback;
  }
}

function saveMenuSettings(settings: GameSettings): void {
  try { window.localStorage.setItem(MENU_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* optional preference */ }
}

function mergeMenuRuntimeSettings(saved: GameSettings, menu: GameSettings): GameSettings {
  return {
    ...saved,
    ...menu,
    // These settings alter deterministic gameplay and follow the selected
    // save instead of the machine-local start-menu preference.
    defaultBeltStackSize: saved.defaultBeltStackSize,
    defaultBeltRouteMode: saved.defaultBeltRouteMode,
    productionBufferLimit: saved.productionBufferLimit,
    logisticsBufferLimit: saved.logisticsBufferLimit,
    beltBufferLimit: saved.beltBufferLimit,
    proliferatorBufferLimit: saved.proliferatorBufferLimit,
    resourceMode: saved.resourceMode,
    difficulty: saved.difficulty,
  };
}

function sourceLabel(source: MenuSaveSource): string {
  if (source === "backup") return "备用存档";
  if (source === "snapshot") return "自动快照";
  return "主存档";
}

function ToggleRow({ checked, label, value, icon, onChange }: {
  checked: boolean;
  label: string;
  value: string;
  icon: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="start-menu-toggle">
      <i>{icon}</i>
      <span><strong>{label}</strong><small>{value}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <b aria-hidden="true"><i /></b>
    </label>
  );
}

function CompositionSafeInput({ value, onValueChange, onBlur, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);
  useEffect(() => {
    if (!composingRef.current) setDraft(value);
  }, [value]);
  const commit = (next: string) => {
    setDraft(next);
    onValueChange(next);
  };
  return <input
    {...props}
    value={draft}
    onChange={(event) => {
      const next = event.currentTarget.value;
      setDraft(next);
      if (!composingRef.current) onValueChange(next);
    }}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={(event) => {
      composingRef.current = false;
      commit(event.currentTarget.value);
    }}
    onBlur={(event) => {
      if (composingRef.current || event.currentTarget.value !== value) {
        composingRef.current = false;
        commit(event.currentTarget.value);
      }
      onBlur?.(event);
    }}
  />;
}

function readRegistrationDraft(): { identifier: string; displayName: string } {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(REGISTRATION_DRAFT_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return { identifier: "", displayName: "" };
    return {
      identifier: typeof (parsed as { identifier?: unknown }).identifier === "string" ? (parsed as { identifier: string }).identifier : "",
      displayName: typeof (parsed as { displayName?: unknown }).displayName === "string" ? (parsed as { displayName: string }).displayName : "",
    };
  } catch {
    return { identifier: "", displayName: "" };
  }
}

export function StartMenu({ onEnterGame, onOpenReleaseNotes }: StartMenuProps) {
  const { locale, setLocale } = useAppLocale();
  const initialContinueSave = useMemo(() => getMenuContinueSave(), []);
  const defaultSettings = { ...DEFAULT_MENU_SETTINGS, ...initialContinueSave?.settings };
  const [view, setView] = useState<StartMenuView>("overview");
  const [continueSave, setContinueSave] = useState<MenuContinueSave | null>(initialContinueSave);
  const [slots, setSlots] = useState(getMenuSlotSummaries);
  const [snapshots, setSnapshots] = useState(getMenuSnapshotSummaries);
  const [settings, setSettings] = useState<GameSettings>(() => readMenuSettings(defaultSettings));
  const [approximateOfflineExperiment, setApproximateOfflineExperiment] = useState(isApproximateOfflineExperimentEnabled);
  useResolvedTheme(settings.theme);
  const [cloudSession, setCloudSession] = useState<CloudSession>({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null });
  const initialCloudAction = useMemo(() => {
    const parameters = new URLSearchParams(window.location.search);
    const verificationToken = parameters.get("verify");
    if (verificationToken) return { kind: "verify" as const, token: verificationToken };
    const resetToken = parameters.get("reset");
    return resetToken ? { kind: "reset" as const, token: resetToken } : null;
  }, []);
  const [cloudMode, setCloudMode] = useState<CloudAuthMode>(initialCloudAction?.kind === "reset" ? "reset" : "login");
  const registrationDraft = useMemo(readRegistrationDraft, []);
  const [cloudIdentifier, setCloudIdentifier] = useState(registrationDraft.identifier);
  const [cloudEmail, setCloudEmail] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudPasswordConfirmation, setCloudPasswordConfirmation] = useState("");
  const [cloudDisplayName, setCloudDisplayName] = useState(registrationDraft.displayName);
  const [cloudConflict, setCloudConflict] = useState<{ slot: CloudSaveSlot; localPayload: string; remote: CloudSaveMetadata; commitLocalAfterUpload?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cloudUploadActive, setCloudUploadActive] = useState(false);
  const [cloudUploadOfflineStage, setCloudUploadOfflineStage] = useState(false);
  const [offlineProgress, setOfflineProgress] = useState<OfflineLoadProgress | null>(null);
  const [message, setMessage] = useState<MenuMessage>(null);
  const [importInspection, setImportInspection] = useState<SaveInspection | null>(null);
  const [importRaw, setImportRaw] = useState<string | null>(null);
  const [rescueConfirmation, setRescueConfirmation] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<(SaveDeleteTarget & { slotId: SaveSlotId }) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const offlineAbortRef = useRef<AbortController | null>(null);
  const cloudUploadAbortRef = useRef<AbortController | null>(null);
  const cloudUploadSkipOfflineRef = useRef(false);
  const cloudAuthAllowed = isSecureCloudClient();
  const cloudMailAvailable = cloudSession.mailAvailable;
  const brandIconUrl = `${import.meta.env.BASE_URL}icon.svg`;
  const automaticSnapshotCount = snapshots.filter((snapshot) => snapshot.reason === "自动快照").length;
  const manualSnapshotCount = snapshots.length - automaticSnapshotCount;

  useEffect(() => {
    if (cloudMode !== "register") return;
    try { window.sessionStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify({ identifier: cloudIdentifier, displayName: cloudDisplayName })); } catch { /* draft recovery is optional */ }
  }, [cloudDisplayName, cloudIdentifier, cloudMode]);

  useEffect(() => {
    const onNativeBack = (event: Event) => {
      if (deleteRequest) {
        event.preventDefault();
        setDeleteRequest(null);
        return;
      }
      if (cloudConflict) {
        event.preventDefault();
        setCloudConflict(null);
        return;
      }
      if (view !== "overview") {
        event.preventDefault();
        setView("overview");
        setMessage(null);
      }
    };
    window.addEventListener(NATIVE_BACK_EVENT, onNativeBack);
    return () => window.removeEventListener(NATIVE_BACK_EVENT, onNativeBack);
  }, [cloudConflict, deleteRequest, view]);

  const refreshLocalSaves = () => {
    setContinueSave(getMenuContinueSave());
    setSlots(getMenuSlotSummaries());
    setSnapshots(getMenuSnapshotSummaries());
  };

  useEffect(() => {
    const bridge = getDesktopBridge();
    const root = document.documentElement;
    root.dataset.uiFontScale = String(Math.round(settings.fontScale * 100));
    if (bridge && typeof bridge.setFontScale === "function") {
      root.dataset.nativeUiScale = "true";
      root.style.removeProperty("--ui-font-scale");
      void bridge.setFontScale(settings.fontScale).catch(() => undefined);
      return;
    }
    delete root.dataset.nativeUiScale;
    root.style.setProperty("--ui-font-scale", String(settings.fontScale));
  }, [settings.fontScale]);

  useEffect(() => {
    if (!cloudAuthAllowed) {
      setCloudSession({ status: "offline", user: null, cloudSave: null, mailAvailable: false, message: "账号登录仅在 HTTPS 安全入口开放" });
      return;
    }
    let active = true;
    const clearActionQuery = () => {
      const next = new URL(window.location.href);
      next.searchParams.delete("verify");
      next.searchParams.delete("reset");
      window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
    };
    if (initialCloudAction?.kind === "reset") {
      setView("cloud");
      setCloudSession({ status: "anonymous", user: null, cloudSave: null, mailAvailable: false, message: null });
      return () => { active = false; };
    }
    if (initialCloudAction?.kind === "verify") {
      setView("cloud");
      setBusy(true);
      void verifyCloudEmail(initialCloudAction.token)
        .then(async () => {
          const session = await resumeCloudSession();
          if (!active) return;
          setCloudSession(session);
          setMessage({ tone: "ready", text: "邮箱验证完成，邮箱找回密码已开放" });
          clearActionQuery();
        })
        .catch((error) => {
          if (!active) return;
          setCloudSession((current) => ({ status: "anonymous", user: null, cloudSave: null, mailAvailable: current.mailAvailable, message: null }));
          setMessage({ tone: "error", text: error instanceof Error ? error.message : "邮箱验证失败" });
        })
        .finally(() => { if (active) setBusy(false); });
      return () => { active = false; };
    }
    void resumeCloudSession().then((session) => { if (active) setCloudSession(session); });
    return () => { active = false; };
  }, [cloudAuthAllowed, initialCloudAction]);

  useEffect(() => () => {
    offlineAbortRef.current?.abort();
    cloudUploadAbortRef.current?.abort();
  }, []);

  const updateMenuSettings = (changes: Partial<GameSettings>) => {
    const next = { ...settings, ...changes };
    setSettings(next);
    saveMenuSettings(next);
  };

  const preserveCurrentSave = async (reason: string, storage?: StorageModule) => {
    const activeStorage = storage ?? await loadStorageModule();
    const state = activeStorage.inspectContinueSave()?.inspection.state;
    if (state) await activeStorage.saveGameSnapshotVerified(state, reason);
  };

  const enterLoadedGame = async (loaded: LoadedGame, preserveReason?: string, storage?: StorageModule) => {
    const activeStorage = storage ?? await loadStorageModule();
    if (preserveReason) await preserveCurrentSave(preserveReason, activeStorage);
    const state = { ...loaded.state, settings: mergeMenuRuntimeSettings(loaded.state.settings, settings) };
    const saveResult = await activeStorage.saveGameVerified(state);
    if (!saveResult.success) throw new Error(saveResult.message);
    trackAnalyticsEvent("game_enter");
    onEnterGame({ ...loaded, state });
  };

  const completeDeferredLoad = async (
    loaded: DeferredLoadedGame,
    label: string,
    preserveReason: string | undefined,
    storage: StorageModule,
  ) => {
    let completed = loaded.state;
    let settlement: OfflineSettlementDiagnostics | undefined;
    if (loaded.offlineSeconds >= 1) {
      const controller = new AbortController();
      offlineAbortRef.current = controller;
      setOfflineProgress({ label, completedSeconds: 0, totalSeconds: loaded.offlineSeconds, progress: 0 });
      const { runOfflineSettlementInWorker } = await importWithRecovery(() => import("../game/offlineSimulation"), "离线结算模块");
      try {
        const result = await runOfflineSettlementInWorker(loaded.state, loaded.offlineSeconds, {
          signal: controller.signal,
          approximate: approximateOfflineExperiment,
          onProgress: (progress) => setOfflineProgress({ label, ...progress }),
        });
        completed = result.state;
        settlement = result.diagnostics;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
        const skipped = storage.cancelDeferredOfflineGame(loaded);
        await enterLoadedGame(skipped, preserveReason, storage);
        return;
      }
    }
    const finalized = storage.finalizeDeferredOfflineGame(loaded, completed, settlement);
    await enterLoadedGame(finalized, preserveReason, storage);
  };

  const handleLoadError = (error: unknown, fallback: string) => {
    if (error instanceof DOMException && error.name === "AbortError") {
      setMessage({ tone: "warning", text: "离线计算已取消，本地存档未发生修改" });
      return;
    }
    setMessage({ tone: "error", text: error instanceof Error ? error.message : fallback });
  };

  const continueGame = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const storage = await loadStorageModule();
      trackAnalyticsEvent("continue_game");
      await completeDeferredLoad(storage.loadGameDeferredOffline(), "恢复最近工厂", undefined, storage);
    } catch (error) {
      handleLoadError(error, "本地存档无法载入");
    } finally {
      offlineAbortRef.current = null;
      setOfflineProgress(null);
      setBusy(false);
    }
  };

  const startNewGame = async () => {
    setBusy(true);
    try {
      const [storage, { createPlayerInitialState }] = await Promise.all([loadStorageModule(), importWithRecovery(() => import("../game/engine"), "模拟核心模块")]);
      await preserveCurrentSave("开始新工厂前", storage);
      const state = createPlayerInitialState();
      state.settings = mergeMenuRuntimeSettings(state.settings, settings);
      const saveResult = await storage.saveGameVerified(state);
      if (!saveResult.success) throw new Error(saveResult.message);
      trackAnalyticsEvent("new_game");
      trackAnalyticsEvent("game_enter");
      onEnterGame({ state, offlineSeconds: 0, offlineReport: null, recovery: { source: "fresh", issues: [] } });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "新工厂初始化失败" });
    } finally {
      setBusy(false);
    }
  };

  const requestNewGame = () => {
    if (continueSave) setView("new");
    else void startNewGame();
  };

  const loadSlot = async (slotId: SaveSlotId) => {
    setBusy(true);
    setMessage(null);
    try {
      const storage = await loadStorageModule();
      const loaded = storage.loadGameSlotDeferredOffline(slotId);
      if (!loaded) {
        setMessage({ tone: "error", text: `本地槽位 ${slotId} 无法载入` });
        return;
      }
      trackAnalyticsEvent("load_save");
      await completeDeferredLoad(loaded, `载入槽位 ${slotId}`, `载入槽位 ${slotId} 前`, storage);
    } catch (error) {
      handleLoadError(error, `本地槽位 ${slotId} 无法载入`);
    } finally {
      offlineAbortRef.current = null;
      setOfflineProgress(null);
      setBusy(false);
    }
  };

  const loadSnapshot = async (snapshotId: string) => {
    setBusy(true);
    try {
      const storage = await loadStorageModule();
      const state = storage.loadSaveSnapshot(snapshotId);
      if (!state) {
        setMessage({ tone: "error", text: "自动快照无法载入" });
        return;
      }
      trackAnalyticsEvent("load_save");
      await enterLoadedGame({ state, offlineSeconds: 0, offlineReport: null }, "回滚自动快照前", storage);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "自动快照无法载入" });
    } finally {
      setBusy(false);
    }
  };

  const readImportFile = async (file: File) => {
    const storage = await loadStorageModule();
    const raw = await file.text();
    const inspection = storage.inspectSave(raw);
    setImportRaw(raw);
    setImportInspection(inspection);
    setRescueConfirmation(false);
    setView("import");
    setMessage(inspection.valid
      ? { tone: inspection.integrity === "valid" ? "ready" : "warning", text: inspection.integrity === "valid" ? "存档校验通过" : "存档将在导入时自动迁移" }
      : inspection.repairable
        ? { tone: "warning", text: "存档校验失败，但结构完整。请先备份原文件，再连续确认两次执行救援。" }
        : { tone: "error", text: inspection.issues[0] ?? "存档格式无效" });
  };

  const confirmImport = async () => {
    if (!importInspection?.valid || !importInspection.state) return;
    const storage = await loadStorageModule();
    trackAnalyticsEvent("import_save");
    await enterLoadedGame({ state: importInspection.state, offlineSeconds: 0, offlineReport: null }, "导入外部存档前", storage);
  };

  const confirmSaveRescue = async () => {
    if (!importInspection?.repairable || importInspection.valid || !importRaw) return;
    if (!rescueConfirmation) {
      setRescueConfirmation(true);
      setMessage({ tone: "warning", text: "二次确认：救援会重新签署可解析状态。原始异常文件将先自动导出备份。" });
      return;
    }
    setBusy(true);
    try {
      const storage = await loadStorageModule();
      const repaired = storage.repairSave(importRaw);
      if (!repaired.success || !repaired.raw || !repaired.inspection.state) throw new Error(repaired.message);
      await exportTextFile({
        contents: importRaw,
        fileName: `dsp-idle-save-rescue-backup-${new Date().toISOString().slice(0, 10)}.json`,
        title: "备份救援前的原始异常存档",
      });
      trackAnalyticsEvent("import_save");
      await enterLoadedGame({ state: repaired.inspection.state, offlineSeconds: 0, offlineReport: null }, "救援外部存档前", storage);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "存档救援失败" });
    } finally {
      setBusy(false);
    }
  };

  const authenticateCloud = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cloudAuthAllowed) return;
    setBusy(true);
    setMessage(null);
    try {
      const session = cloudMode === "register"
        ? await registerCloudAccount(cloudIdentifier, cloudPassword, cloudDisplayName)
        : await loginCloudAccount(cloudIdentifier, cloudPassword);
      setCloudSession(session);
      trackAnalyticsEvent(cloudMode === "register" ? "cloud_register" : "cloud_login");
      setCloudPassword("");
      if (cloudMode === "register") {
        try { window.sessionStorage.removeItem(REGISTRATION_DRAFT_KEY); } catch { /* optional draft */ }
      }
      setMessage({ tone: "ready", text: cloudMode === "register" ? "云账户已创建，云存档与自动同步已开放" : "云账户登录成功，本地存档保持不变" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "云账户登录失败" });
    } finally {
      setBusy(false);
    }
  };

  const requestPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cloudMailAvailable) {
      setMessage({ tone: "warning", text: "邮箱找回密码正在开发中" });
      setCloudMode("login");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await requestCloudPasswordReset(cloudEmail);
      setMessage({ tone: "ready", text: result });
      setCloudMode("login");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "重置邮件发送失败" });
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!initialCloudAction || initialCloudAction.kind !== "reset") return;
    if (cloudPassword !== cloudPasswordConfirmation) {
      setMessage({ tone: "error", text: "两次输入的新密码不一致" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const session = await resetCloudPassword(initialCloudAction.token, cloudPassword);
      setCloudSession(session);
      setCloudPassword("");
      setCloudPasswordConfirmation("");
      const next = new URL(window.location.href);
      next.searchParams.delete("reset");
      window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
      setMessage({ tone: "ready", text: "密码已重置，其他设备会话已退出" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "密码重置失败" });
    } finally {
      setBusy(false);
    }
  };

  const uploadLocalSave = async () => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user || !continueSave) return;
    const userId = cloudSession.user.id;
    let attemptedPayload: string | null = null;
    let controller = new AbortController();
    cloudUploadAbortRef.current = controller;
    cloudUploadSkipOfflineRef.current = false;
    setCloudUploadActive(true);
    setCloudUploadOfflineStage(true);
    setBusy(true);
    setMessage({ tone: "busy", text: "准备上传" });
    try {
      // Let React paint the stage before any module loading or Worker message
      // transfers begin. This is important for multi-megabyte local saves.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const storage = await loadStorageModule();
      const { prepareCloudUploadInWorker } = await importWithRecovery(() => import("../game/offlineSimulation"), "云存档后台模块");
      const prepare = (skipOffline = false) => prepareCloudUploadInWorker(continueSave.raw, {
        signal: controller.signal,
        now: Date.now(),
        menuSettings: settings,
        returningRewardClaimed: storage.hasReturningRewardClaim(continueSave.summary.savedAt),
        skipOffline,
        onProgress: (progress) => {
          if (progress.totalSeconds > 0) {
            setMessage({ tone: "busy", text: `离线结算 ${Math.round(progress.progress * 100)}%` });
          }
        },
      });
      setMessage({ tone: "busy", text: "离线结算" });
      let prepared;
      try {
        prepared = await prepare();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError") || !cloudUploadSkipOfflineRef.current) throw error;
        cloudUploadSkipOfflineRef.current = false;
        controller = new AbortController();
        cloudUploadAbortRef.current = controller;
        setMessage({ tone: "busy", text: "已放弃离线运算，上传当前存档" });
        prepared = await prepare(true);
      }
      setCloudUploadOfflineStage(false);
      setMessage({ tone: "busy", text: "生成校验" });
      attemptedPayload = prepared.payload;
      const comparison = compareCloudSaveSummary(userId, prepared.summary, cloudSession.cloudSave);
      if (cloudSession.cloudSave && ["cloud-newer", "conflict", "unbound"].includes(comparison.state)) {
        setCloudConflict({ slot: "main", localPayload: prepared.payload, remote: cloudSession.cloudSave, commitLocalAfterUpload: true });
        setMessage({ tone: "warning", text: "检测到本地与云端进度分叉，请先选择保留版本" });
        return;
      }
      setMessage({ tone: "busy", text: "压缩请求" });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      setMessage({ tone: "busy", text: "上传云端" });
      const uploaded = await uploadCloudSaveWithOptions(prepared.payload, cloudSession.cloudSave?.revision ?? 0, "main", {
        verified: true,
        signal: controller.signal,
        onStage: (stage) => setMessage({ tone: "busy", text: cloudUploadStageLabel(stage) }),
      });
      let cloudSave = uploaded;
      try {
        // Once the PUT has returned a new revision, cancellation must not
        // turn a confirmed cloud update into a misleading local "cancelled".
        cloudSave = await refreshCloudSaveMetadata("main") ?? uploaded;
      } catch (error) {
        // The PUT response is already authoritative. Metadata refresh is a
        // best-effort read and must not hide the confirmed revision.
      }
      const localSaveResult = await storage.saveVerifiedPayload(prepared.payload, { verified: true });
      if (!localSaveResult.success) {
        updateCloudSlot("main", cloudSave);
        setMessage({ tone: "error", text: `云存档已更新到修订 ${cloudSave.revision}，但本地存档未写入：${localSaveResult.message}` });
        return;
      }
      if (prepared.returningReward.length > 0) storage.markReturningRewardClaimed(continueSave.summary.savedAt);
      markCloudSaveSynchronized(userId, cloudSave);
      trackAnalyticsEvent("cloud_upload");
      updateCloudSlot("main", cloudSave);
      setContinueSave((current) => current ? {
        ...current,
        raw: prepared.payload,
        summary: {
          savedAt: prepared.summary.savedAt,
          elapsedSeconds: prepared.summary.elapsedSeconds,
          completedTechCount: prepared.summary.completedTechCount,
          structurePoints: prepared.summary.structurePoints,
          activePlanetId: prepared.summary.activePlanetId as MenuContinueSave["summary"]["activePlanetId"],
        },
      } : current);
      setMessage({ tone: "ready", text: `云存档已更新到修订 ${cloudSave.revision}` });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage({ tone: "warning", text: "云存档上传已取消，本地有效存档未删除" });
        return;
      }
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        if (attemptedPayload) setCloudConflict({ slot: "main", localPayload: attemptedPayload, remote: error.payload.cloudSave as CloudSaveMetadata, commitLocalAfterUpload: true });
      }
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "云存档上传失败" });
    } finally {
      cloudUploadAbortRef.current = null;
      cloudUploadSkipOfflineRef.current = false;
      setCloudUploadActive(false);
      setCloudUploadOfflineStage(false);
      setBusy(false);
    }
  };

  const skipCloudUploadOffline = () => {
    if (!cloudUploadOfflineStage) return;
    cloudUploadSkipOfflineRef.current = true;
    cloudUploadAbortRef.current?.abort();
  };

  const cancelCloudUpload = () => {
    cloudUploadSkipOfflineRef.current = false;
    cloudUploadAbortRef.current?.abort();
  };

  const updateCloudSlot = (slot: CloudSaveSlot, cloudSave: CloudSaveMetadata) => {
    setCloudSession((current) => ({
      ...current,
      cloudSave: slot === "main" ? cloudSave : current.cloudSave,
      cloudSaves: { main: current.cloudSave, "1": null, "2": null, "3": null, ...current.cloudSaves, [slot]: cloudSave },
    }));
  };

  const uploadManualCloudSlot = async (slot: Exclude<CloudSaveSlot, "main">) => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const slotId = Number(slot) as SaveSlotId;
    setBusy(true);
    setMessage(null);
    try {
      const storage = await loadStorageModule();
      const localPayload = storage.exportGameSlot(slotId);
      if (!localPayload) throw new Error(`本地槽位 ${slot} 为空或校验失败`);
      const remote = cloudSession.cloudSaves?.[slot] ?? null;
      const comparison = compareCloudSave(cloudSession.user.id, localPayload, remote, slot);
      if (remote && ["cloud-newer", "conflict", "unbound"].includes(comparison.state)) {
        setCloudConflict({ slot, localPayload, remote });
        setMessage({ tone: "warning", text: `本地槽位 ${slot} 与云端版本不同，请选择保留版本` });
        return;
      }
      const uploaded = await uploadCloudSave(localPayload, remote?.revision ?? 0, slot, {
        onStage: (stage) => setMessage({ tone: "busy", text: `槽位 ${slot} · ${cloudUploadStageLabel(stage)}` }),
      });
      const cloudSave = await refreshCloudSaveMetadata(slot).catch(() => uploaded) ?? uploaded;
      markCloudSaveSynchronized(cloudSession.user.id, cloudSave, localPayload, slot);
      updateCloudSlot(slot, cloudSave);
      setMessage({ tone: "ready", text: `本地槽位 ${slot} 已上传为云端修订 ${cloudSave.revision}` });
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        const storage = await loadStorageModule();
        const localPayload = storage.exportGameSlot(slotId);
        if (localPayload) setCloudConflict({ slot, localPayload, remote: error.payload.cloudSave as CloudSaveMetadata });
      }
      setMessage({ tone: "error", text: error instanceof Error ? error.message : `云端槽位 ${slot} 上传失败` });
    } finally {
      setBusy(false);
    }
  };

  const downloadManualCloudSlot = async (slot: Exclude<CloudSaveSlot, "main">) => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const remote = cloudSession.cloudSaves?.[slot] ?? null;
    if (!remote) return;
    setBusy(true);
    setMessage(null);
    try {
      const storage = await loadStorageModule();
      const localPayload = storage.exportGameSlot(Number(slot) as SaveSlotId);
      const comparison = compareCloudSave(cloudSession.user.id, localPayload, remote, slot);
      if (localPayload && comparison.state !== "synced") {
        setCloudConflict({ slot, localPayload, remote });
        setMessage({ tone: "warning", text: `槽位 ${slot} 的本地与云端进度不同，请选择版本` });
        return;
      }
      const cloudSave = await downloadCloudSave(undefined, slot);
      if (!cloudSave) throw new Error(`云端槽位 ${slot} 为空`);
      const inspection = storage.inspectSave(cloudSave.payload);
      if (!inspection.valid || !inspection.state) throw new Error(inspection.issues[0] ?? "云存档格式无效");
      const saveResult = await storage.saveGameSlotVerified(Number(slot) as SaveSlotId, inspection.state);
      if (!saveResult.success) throw new Error(saveResult.message);
      markCloudSaveSynchronized(cloudSession.user.id, cloudSave, cloudSave.payload, slot);
      refreshLocalSaves();
      setMessage({ tone: "ready", text: `云端槽位 ${slot} 已下载到对应本地槽位` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : `云端槽位 ${slot} 下载失败` });
    } finally {
      setBusy(false);
    }
  };

  const downloadAndEnterCloudSave = async () => {
    if (cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const userId = cloudSession.user.id;
    setBusy(true);
    setMessage(null);
    try {
      const cloudSave = await downloadCloudSave();
      if (!cloudSave) {
        setMessage({ tone: "warning", text: "该账户还没有云存档" });
        return;
      }
      const storage = await loadStorageModule();
      const inspection = storage.inspectSave(cloudSave.payload);
      if (!inspection.valid || !inspection.state) {
        if (inspection.repairable && inspection.state) {
          setImportRaw(cloudSave.payload);
          setImportInspection(inspection);
          setRescueConfirmation(false);
          setView("import");
          setMessage({ tone: "warning", text: "云端存档结构完整但校验失败，已转到受控救援入口。" });
          return;
        }
        setMessage({ tone: "error", text: inspection.issues[0] ?? "云存档格式无效" });
        return;
      }
      markCloudSaveSynchronized(userId, cloudSave, cloudSave.payload);
      trackAnalyticsEvent("cloud_download");
      await enterLoadedGame({ state: inspection.state, offlineSeconds: 0, offlineReport: null }, "下载云存档前", storage);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "云存档下载失败" });
    } finally {
      setBusy(false);
    }
  };

  const useCloudConflictVersion = async () => {
    if (!cloudConflict || cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const userId = cloudSession.user.id;
    setBusy(true);
    try {
      const cloudSave = await downloadCloudSave(cloudConflict.remote.revision, cloudConflict.slot);
      if (!cloudSave) throw new Error("云端修订已不可用，请重新连接后再试");
      const storage = await loadStorageModule();
      const inspection = storage.inspectSave(cloudSave.payload);
      if (!inspection.valid || !inspection.state) {
        if (inspection.repairable && inspection.state && cloudConflict.slot === "main") {
          setImportRaw(cloudSave.payload);
          setImportInspection(inspection);
          setRescueConfirmation(false);
          setCloudConflict(null);
          setView("import");
          setMessage({ tone: "warning", text: "云端主存档结构完整但校验失败，已转到受控救援入口。" });
          return;
        }
        throw new Error(inspection.issues[0] ?? "云存档格式无效");
      }
      markCloudSaveSynchronized(userId, cloudSave, cloudSave.payload, cloudConflict.slot);
      setCloudConflict(null);
      trackAnalyticsEvent("cloud_download");
      if (cloudConflict.slot === "main") {
        await enterLoadedGame({ state: inspection.state, offlineSeconds: 0, offlineReport: null }, "解决云存档冲突前", storage);
      } else {
        const saveResult = await storage.saveGameSlotVerified(Number(cloudConflict.slot) as SaveSlotId, inspection.state);
        if (!saveResult.success) throw new Error(saveResult.message);
        refreshLocalSaves();
        setMessage({ tone: "ready", text: `已在本地槽位 ${cloudConflict.slot} 保留云端版本` });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "云端版本读取失败" });
    } finally {
      setBusy(false);
    }
  };

  const keepLocalConflictVersion = async () => {
    if (!cloudConflict || cloudSession.status !== "authenticated" || !cloudSession.user) return;
    const pendingConflict = cloudConflict;
    const userId = cloudSession.user.id;
    setBusy(true);
    try {
      const uploaded = await uploadCloudSave(pendingConflict.localPayload, pendingConflict.remote.revision, pendingConflict.slot, {
        onStage: (stage) => setMessage({ tone: "busy", text: cloudUploadStageLabel(stage) }),
      });
      const cloudSave = await refreshCloudSaveMetadata(pendingConflict.slot).catch(() => uploaded) ?? uploaded;
      if (pendingConflict.commitLocalAfterUpload && pendingConflict.slot === "main") {
        const storage = await loadStorageModule();
        const localSaveResult = await storage.saveVerifiedPayload(pendingConflict.localPayload, { verified: true });
        if (!localSaveResult.success) {
          updateCloudSlot(pendingConflict.slot, cloudSave);
          setCloudConflict((current) => current ? { ...current, remote: cloudSave } : current);
          setMessage({ tone: "error", text: `云端已更新到修订 ${cloudSave.revision}，但本地存档未写入：${localSaveResult.message}` });
          return;
        }
      }
      markCloudSaveSynchronized(userId, cloudSave, pendingConflict.localPayload, pendingConflict.slot);
      updateCloudSlot(pendingConflict.slot, cloudSave);
      setCloudConflict(null);
      setMessage({ tone: "ready", text: `本地进度已保存为云端修订 ${cloudSave.revision}` });
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && error.payload.cloudSave) {
        setCloudConflict((current) => current ? { ...current, remote: error.payload.cloudSave as CloudSaveMetadata } : current);
      }
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "本地版本上传失败" });
    } finally {
      setBusy(false);
    }
  };

  const summary = continueSave?.summary;
  const summaryPlanet = summary ? getMenuPlanetName(summary.activePlanetId) : null;
  const cloudStateLabel = cloudSession.status === "authenticated" ? "云端已登录" : cloudSession.status === "offline" ? "云端离线" : cloudSession.status === "checking" ? "连接云节点" : "云端未登录";
  const comparisonPayload = continueSave?.raw ?? null;
  const cloudComparison = cloudSession.status === "authenticated" && cloudSession.user
    ? compareCloudSave(cloudSession.user.id, comparisonPayload, cloudSession.cloudSave)
    : null;

  return (
    <main className="start-menu" data-reduced-motion={settings.reducedMotion ? "true" : "false"}>
      <div className="start-menu-scene" aria-hidden="true">
        <div className="start-menu-orbit start-menu-orbit--outer" />
        <div className="start-menu-orbit start-menu-orbit--inner" />
        <i className="start-menu-star" />
        <span className="start-menu-scene-node start-menu-scene-node--ore">Fe</span>
        <span className="start-menu-scene-node start-menu-scene-node--smelt">熔</span>
        <span className="start-menu-scene-node start-menu-scene-node--assemble">制</span>
        <span className="start-menu-scene-node start-menu-scene-node--matrix">矩</span>
        <b className="start-menu-scene-line start-menu-scene-line--one" />
        <b className="start-menu-scene-line start-menu-scene-line--two" />
        <b className="start-menu-scene-line start-menu-scene-line--three" />
      </div>

      <header className="start-menu-topbar">
        <div className="start-menu-brand-mini"><img src={brandIconUrl} alt="" /><strong>DSP极简网络</strong></div>
        <div className="start-menu-language-prominent" role="group" aria-label="Language / 语言">
          <button className={locale === "zh-CN" ? "active" : ""} type="button" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>中文</button>
          <button className={locale === "en" ? "active" : ""} type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
        </div>
        <div className={`start-menu-node-state start-menu-node-state--${cloudSession.status}`}>
          {cloudSession.status === "offline" ? <CloudOff size={14} /> : <Cloud size={14} />}
          <span>{cloudStateLabel}</span>
        </div>
      </header>

      {offlineProgress ? <section className="start-menu-offline-progress" role="dialog" aria-modal="true" aria-labelledby="offline-progress-title">
        <div>
          <Activity size={22} />
          <span>
            <strong id="offline-progress-title">正在进行离线运算</strong>
            <small>{offlineProgress.label} · {offlineSettlementPhaseLabel(offlineProgress.phase ?? "exact", locale)} · {Math.floor(offlineProgress.completedSeconds).toLocaleString(locale)} / {Math.floor(offlineProgress.totalSeconds).toLocaleString(locale)} {locale === "en" ? "sec" : "秒"}</small>
          </span>
        </div>
        <progress max={1} value={Math.max(0, Math.min(1, offlineProgress.progress))} />
        <p>完成后才会一次性保存并进入工厂；放弃后直接进入当前存档，不发放离线收益。</p>
        <button type="button" onClick={() => offlineAbortRef.current?.abort()}>放弃离线并直接进入</button>
      </section> : null}

      <section className="start-menu-layout">
        <aside className="start-menu-command">
          <div className="start-menu-title">
            <img src={brandIconUrl} alt="DSP极简网络" />
            <span><small>母星工业节点</small><h1>DSP极简网络</h1><em>v{__APP_VERSION__}</em></span>
          </div>

          <div className="start-menu-resume">
            <span>{continueSave ? sourceLabel(continueSave.source) : "新工厂协议"}</span>
            <strong>{continueSave ? formatSavedAt(summary?.savedAt) : "等待启动"}</strong>
            <small>{summary ? `${summaryPlanet ?? "未知行星"} · ${formatRuntime(summary.elapsedSeconds)} · 科技 ${summary.completedTechCount}` : "初始建设物资已装载"}</small>
          </div>

          <button className="start-menu-primary" type="button" disabled={busy} onClick={continueSave ? continueGame : requestNewGame}>
            {busy ? <Activity size={19} /> : <Play size={19} />}
            <span><small>{continueSave ? "恢复最近工厂" : "建立母星节点"}</small><strong>{continueSave ? "继续游戏" : "开始游戏"}</strong></span>
            <ArrowRight size={19} />
          </button>

          <nav className="start-menu-nav" aria-label="主菜单">
            <button className={view === "new" ? "active" : ""} type="button" onClick={requestNewGame}><Plus size={17} /><span>新建游戏</span></button>
            <button className={view === "saves" ? "active" : ""} type="button" onClick={() => { setView("saves"); setMessage(null); }}><HardDrive size={17} /><span>加载存档</span><em>{slots.length}</em></button>
            <button className={view === "cloud" ? "active" : ""} type="button" onClick={() => { setView("cloud"); setMessage(null); }}><Cloud size={17} /><span>登录与云存档</span></button>
            <button className={view === "import" ? "active" : ""} type="button" onClick={() => fileInputRef.current?.click()}><FileUp size={17} /><span>导入存档</span></button>
            <button className={view === "settings" ? "active" : ""} type="button" onClick={() => { setView("settings"); setMessage(null); }}><Settings size={17} /><span>游戏设置</span></button>
            {__APP_PLATFORM__ === "web" ? <a className="start-menu-download-link" href={NATIVE_DOWNLOAD_URL} target="_blank" rel="noreferrer" title="下载 Windows 或 Android 客户端"><Download size={17} /><span>客户端下载</span><em>测试版</em></a> : null}
          </nav>
          <input ref={fileInputRef} className="start-menu-file-input" type="file" accept="application/json,.json" aria-label="选择存档文件" onChange={async (event) => { const file = event.target.files?.[0]; if (file) await readImportFile(file); event.target.value = ""; }} />
        </aside>

        <section className="start-menu-workspace" aria-live="polite">
          {view === "overview" ? <div className="start-menu-overview">
            <header><span>工厂状态</span><strong>{continueSave ? "可继续运行" : "等待初始化"}</strong></header>
            <div className="start-menu-overview-metrics">
              <span><i><Clock3 size={16} /></i><small>累计运行</small><strong>{summary ? formatRuntime(summary.elapsedSeconds) : "0 分钟"}</strong></span>
              <span><i><Gauge size={16} /></i><small>已完成科技</small><strong>{summary?.completedTechCount ?? 0}</strong></span>
              <span><i><Factory size={16} /></i><small>结构点数</small><strong><QuantityValue value={summary?.structurePoints ?? 0} /></strong></span>
              <span><i><Database size={16} /></i><small>本地槽位</small><strong>{slots.length}/3</strong></span>
            </div>
            <div className="start-menu-flow-status">
              <span><i className="ready" /><strong>本地存档</strong><small>{continueSave ? "已检测" : "空"}</small></span>
              <b />
              <span><i className={cloudSession.status === "authenticated" ? "ready" : "idle"} /><strong>云端节点</strong><small>{cloudStateLabel}</small></span>
              <b />
              <span><i className="ready" /><strong>模拟核心</strong><small>待启动</small></span>
            </div>
            <section className="start-menu-project-note" aria-label="项目说明">
              <header><ShieldCheck size={16} /><strong>免费个人作品</strong><span><MessageCircle size={13} />QQ 交流群 1076757280</span></header>
              <p>本项目为免费个人作品，仅供交流与学习使用。欢迎大家提出宝贵的意见与建议。</p>
              <p>强烈推荐您在体验本项目之前，购买并游玩《戴森球计划》，相信它会为您带来更加丰富而精彩的游戏体验。</p>
              <p>进入工厂后会使用本机生成的匿名标识统计游玩与在线人数，不采集完整存档或设备指纹。</p>
            </section>
            <footer><button type="button" onClick={() => setView("saves")}><History size={15} />查看存档记录</button><button className="primary" type="button" disabled={busy} onClick={continueSave ? () => void continueGame() : requestNewGame}><Play size={15} />{continueSave ? "进入工厂" : "建立工厂"}</button></footer>
          </div> : null}

          {view === "new" ? <div className="start-menu-new">
            <header><Plus size={22} /><span><small>新工厂协议</small><strong>建立新的母星生产网络</strong></span></header>
            <div className="start-menu-new-loadout"><span><small>风力涡轮机</small><strong>3</strong></span><span><small>采矿机</small><strong>2</strong></span><span><small>熔炉</small><strong>3</strong></span><span><small>制造台</small><strong>3</strong></span><span><small>研究站</small><strong>2</strong></span><span><small>传送带</small><strong>10</strong></span></div>
            {continueSave ? <p className="start-menu-warning"><ShieldCheck size={16} />当前工厂会先保存为自动快照。</p> : null}
            <footer><button type="button" onClick={() => setView("overview")}>取消</button><button className="primary" type="button" disabled={busy} onClick={() => void startNewGame()}><Plus size={15} />{busy ? "正在建立" : "开始新游戏"}</button></footer>
          </div> : null}

          {view === "saves" ? <div className="start-menu-saves">
            <header><span><small>本地数据</small><strong>加载存档</strong></span><em>{slots.length + snapshots.length + (continueSave ? 1 : 0)} 个恢复点</em></header>
            <div className="start-menu-save-list">
              {continueSave ? <article className="primary"><i><Save size={16} /></i><span><strong>{sourceLabel(continueSave.source)}</strong><small>{formatSavedAt(summary?.savedAt)} · {summaryPlanet} · 科技 {summary?.completedTechCount}</small></span><em>{formatRuntime(summary?.elapsedSeconds ?? 0)}</em><button type="button" disabled={busy} onClick={() => void continueGame()}><Play size={14} />载入</button></article> : null}
              {([1, 2, 3] as SaveSlotId[]).map((slotId) => {
                const slot = slots.find((candidate) => candidate.slotId === slotId);
                return <article className={slot ? "" : "empty"} key={slotId}><i><HardDrive size={16} /></i><span><strong>本地槽位 {slotId}</strong><small>{slot ? `${formatSavedAt(slot.savedAt)} · ${getMenuPlanetName(slot.activePlanetId)} · 科技 ${slot.completedTechCount}` : "空槽位"}</small></span><em>{slot ? formatRuntime(slot.elapsedSeconds) : "--"}</em><div className="start-menu-save-actions"><button type="button" disabled={busy || !slot?.valid} onClick={() => void loadSlot(slotId)}><Upload size={14} />载入</button><button className="danger" type="button" disabled={busy || !slot} onClick={() => slot && setDeleteRequest({ slotId, label: `本地槽位 ${slotId}`, details: `${formatSavedAt(slot.savedAt)} · ${getMenuPlanetName(slot.activePlanetId)} · 运行 ${formatRuntime(slot.elapsedSeconds)} · 科技 ${slot.completedTechCount}` })} title={`删除本地槽位 ${slotId}`} aria-label={`删除本地槽位 ${slotId}`}><Trash2 size={14} /></button></div></article>;
              })}
            </div>
            {snapshots.length > 0 ? <section className="start-menu-snapshots"><header><History size={14} /><strong>最近快照</strong><small>自动 {automaticSnapshotCount}/2 · 手动 {manualSnapshotCount}</small></header>{snapshots.slice(0, 3).map((snapshot) => <button type="button" disabled={busy || !snapshot.valid} onClick={() => void loadSnapshot(snapshot.id)} key={snapshot.id}><span><strong>{snapshot.reason}</strong><small>{formatSavedAt(snapshot.savedAt)} · 科技 {snapshot.completedTechCount}</small></span><em>{formatRuntime(snapshot.elapsedSeconds)}</em><RefreshCw size={13} /></button>)}</section> : null}
          </div> : null}

          {view === "cloud" ? <div className="start-menu-cloud">
            <header><span><small>银河数据节点</small><strong>账户与云存档</strong></span><em className={`cloud-${cloudSession.status}`}>{cloudStateLabel}</em></header>
            {!cloudAuthAllowed ? <div className="start-menu-cloud-offline"><ShieldCheck size={24} /><span><strong>需要 HTTPS 安全入口</strong><small>请使用 HTTPS 或本地开发入口</small></span></div> : null}
            {cloudAuthAllowed && cloudSession.status === "checking" ? <div className="start-menu-cloud-offline"><Activity size={24} /><span><strong>正在连接云节点</strong><small>验证服务状态与登录令牌</small></span></div> : null}
            {cloudAuthAllowed && cloudSession.status === "offline" ? <div className="start-menu-cloud-offline"><CloudOff size={24} /><span><strong>云节点暂时不可用</strong><small>{cloudSession.message}</small></span><button type="button" onClick={() => { setCloudSession({ status: "checking", user: null, cloudSave: null, mailAvailable: false, message: null }); void resumeCloudSession().then(setCloudSession); }}><RefreshCw size={14} />重试</button></div> : null}
            {cloudSession.status === "anonymous" && (cloudMode === "login" || cloudMode === "register") ? <form className="start-menu-auth" onSubmit={authenticateCloud}>
              <div className="start-menu-auth-mode"><button className={cloudMode === "login" ? "active" : ""} type="button" onClick={() => setCloudMode("login")}><LogIn size={14} />登录</button><button className={cloudMode === "register" ? "active" : ""} type="button" onClick={() => setCloudMode("register")}><UserPlus size={14} />注册</button></div>
              {!cloudMailAvailable ? <p className="start-menu-auth-development"><MailWarning size={14} /><span><strong>邮件系统尚未开放</strong><small>用户名密码注册、主云存档、三个手动槽、自动同步和排行榜均可使用；未绑定邮箱暂时无法找回密码。</small></span></p> : null}
              {cloudMode === "register" ? <label><span>显示名称</span><CompositionSafeInput name="displayName" value={cloudDisplayName} onValueChange={setCloudDisplayName} minLength={2} maxLength={24} required autoComplete="nickname" /></label> : null}
              <label><span>{cloudMode === "register" ? "用户名" : "用户名或邮箱"}</span><CompositionSafeInput name="username" type="text" value={cloudIdentifier} onValueChange={setCloudIdentifier} required minLength={cloudMode === "register" ? 4 : undefined} maxLength={cloudMode === "register" ? 24 : 254} pattern={cloudMode === "register" ? "[A-Za-z0-9_]{4,24}" : undefined} title={cloudMode === "register" ? "4 至 24 位英文字母、数字或下划线" : undefined} autoComplete="username" placeholder={cloudMode === "register" ? "4-24 位字母、数字或下划线" : "用户名或已绑定邮箱"} /></label>
              <label><span>密码</span><input type="password" value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} required minLength={8} maxLength={128} autoComplete={cloudMode === "register" ? "new-password" : "current-password"} /></label>
              {cloudMode === "login" ? <button className="start-menu-auth-link" type="button" disabled={!cloudMailAvailable} title={!cloudMailAvailable ? "邮箱找回密码正在开发中" : undefined} onClick={() => setCloudMode("forgot")}>{cloudMailAvailable ? "忘记密码" : "忘记密码 · 开发中"}</button> : null}
              <button className="primary" type="submit" disabled={busy}>{busy ? <Activity size={15} /> : cloudMode === "register" ? <UserPlus size={15} /> : <LogIn size={15} />}{cloudMode === "register" ? "创建云账户" : "登录云账户"}</button>
            </form> : null}
            {cloudSession.status === "anonymous" && cloudMode === "forgot" ? <form className="start-menu-auth" onSubmit={requestPasswordReset}>
              <header><span><small>账号恢复</small><strong>找回密码</strong></span></header>
              <label><span>注册邮箱</span><input type="email" value={cloudEmail} onChange={(event) => setCloudEmail(event.target.value)} required maxLength={254} autoComplete="email" /></label>
              <div className="start-menu-auth-actions"><button type="button" onClick={() => setCloudMode("login")}>返回登录</button><button className="primary" type="submit" disabled={busy}>{busy ? <Activity size={15} /> : <RefreshCw size={15} />}发送重置邮件</button></div>
            </form> : null}
            {cloudSession.status === "anonymous" && cloudMode === "reset" ? <form className="start-menu-auth" onSubmit={submitPasswordReset}>
              <header><span><small>账号恢复</small><strong>设置新密码</strong></span></header>
              <label><span>新密码</span><input type="password" value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" /></label>
              <label><span>确认新密码</span><input type="password" value={cloudPasswordConfirmation} onChange={(event) => setCloudPasswordConfirmation(event.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" /></label>
              <button className="primary" type="submit" disabled={busy}>{busy ? <Activity size={15} /> : <RefreshCw size={15} />}确认重置</button>
            </form> : null}
            {cloudSession.status === "authenticated" && cloudSession.user ? <div className="start-menu-cloud-account">
              <section className="start-menu-cloud-user"><i>{cloudSession.user.displayName.slice(0, 1).toUpperCase()}</i><span><strong>{cloudSession.user.displayName}</strong><small>@{cloudSession.user.username}{cloudSession.user.email ? ` · ${cloudSession.user.email}` : ""}</small></span><button type="button" title="退出云账户" aria-label="退出云账户" onClick={() => { setBusy(true); void logoutCloudAccount().then(() => setCloudSession((current) => ({ status: "anonymous", user: null, cloudSave: null, mailAvailable: current.mailAvailable, message: null }))).finally(() => setBusy(false)); }}><LogOut size={15} /></button></section>
              <section className="start-menu-cloud-save"><header><Cloud size={18} /><span><small>当前主存档</small><strong>{cloudSession.cloudSave ? `修订 ${cloudSession.cloudSave.revision}` : "尚未上传"}</strong></span><em>{cloudSession.cloudSave ? formatSavedAt(cloudSession.cloudSave.updatedAt) : "--"}</em></header>{cloudComparison ? <p className={`cloud-sync-state cloud-sync-state--${cloudComparison.state}`}>{cloudSyncLabel(cloudComparison.state)}</p> : null}<dl className="cloud-sync-summary"><div><dt>本地进度</dt><dd>{comparisonPayload ? `${formatRuntime(cloudComparison?.local?.elapsedSeconds ?? 0)} · 科技 ${cloudComparison?.local?.completedTechCount ?? 0}` : "无本地存档"}</dd></div><div><dt>云端进度</dt><dd>{cloudSession.cloudSave?.summary ? `${formatRuntime(cloudSession.cloudSave.summary.elapsedSeconds)} · 科技 ${cloudSession.cloudSave.summary.completedTechCount}` : cloudSession.cloudSave ? "旧版摘要待更新" : "无云存档"}</dd></div></dl><div><button type="button" disabled={busy || !continueSave} onClick={() => void uploadLocalSave()}><Upload size={14} />上传本地存档</button>{cloudUploadActive && cloudUploadOfflineStage ? <button type="button" onClick={skipCloudUploadOffline}><SkipForward size={14} />跳过离线并继续上传</button> : null}{cloudUploadActive ? <button type="button" onClick={cancelCloudUpload}><CloudOff size={14} />取消上传</button> : null}<button className="primary" type="button" disabled={busy || !cloudSession.cloudSave} onClick={() => void downloadAndEnterCloudSave()}><Download size={14} />下载并进入</button></div></section>
              <CloudSaveSlotsPanel cloudSaves={cloudSession.cloudSaves} localSlots={slots} busySlot={busy ? "main" : null} uploadDisabled={false} onUpload={(slot) => void uploadManualCloudSlot(slot)} onDownload={(slot) => void downloadManualCloudSlot(slot)} />
              <CloudAccountSecurity user={cloudSession.user} mailAvailable={cloudMailAvailable} onUserChange={(user) => setCloudSession((current) => ({ ...current, user }))} onLoggedOut={() => setCloudSession((current) => ({ status: "anonymous", user: null, cloudSave: null, mailAvailable: current.mailAvailable, message: null }))} />
            </div> : null}
            {cloudConflict ? <CloudSaveConflictDialog local={summarizeCloudPayload(cloudConflict.localPayload)} cloud={cloudConflict.remote} busy={busy} onUseCloud={() => void useCloudConflictVersion()} onKeepLocal={() => void keepLocalConflictVersion()} onCancel={() => setCloudConflict(null)} /> : null}
          </div> : null}

          {view === "import" ? <div className="start-menu-import">
            <header><FileUp size={22} /><span><small>外部数据</small><strong>导入存档</strong></span></header>
            {!importInspection ? <button className="start-menu-import-drop" type="button" onClick={() => fileInputRef.current?.click()}><FileUp size={25} /><strong>选择 JSON 存档</strong><small>支持当前格式与可迁移的旧版本</small></button> : <div className={`start-menu-import-result start-menu-import-result--${importInspection.valid ? importInspection.integrity : "corrupt"}`}><header><i>{importInspection.valid ? <Check size={18} /> : <CloudOff size={18} />}</i><span><strong>{importInspection.valid ? "存档可导入" : importInspection.repairable ? "存档结构完整，可受控救援" : "存档不可用"}</strong><small>格式 v{importInspection.formatVersion ?? "?"} · 状态 v{importInspection.stateVersion ?? "?"}</small></span></header><div><span><small>运行时间</small><strong>{formatRuntime(importInspection.summary?.elapsedSeconds ?? 0)}</strong></span><span><small>实体数量</small><strong>{importInspection.state?.entities.length ?? 0}</strong></span><span><small>完成科技</small><strong>{importInspection.summary?.completedTechCount ?? 0}</strong></span></div>{importInspection.issues.length > 0 ? <ul>{importInspection.issues.slice(0, 4).map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}<footer><button type="button" onClick={() => fileInputRef.current?.click()}>重新选择</button>{importInspection.valid ? <button className="primary" type="button" disabled={busy} onClick={() => void confirmImport()}><FileUp size={14} />确认导入并进入</button> : importInspection.repairable ? <button className={rescueConfirmation ? "danger" : "primary"} type="button" disabled={busy} onClick={() => void confirmSaveRescue()}><ShieldCheck size={14} />{rescueConfirmation ? "再次确认并救援" : "救援此存档"}</button> : <button type="button" disabled>无法导入</button>}</footer></div>}
          </div> : null}

          {view === "settings" ? <div className="start-menu-settings">
            <header><span><small>本机运行参数</small><strong>游戏设置</strong></span><em>即时生效</em></header>
            <section><header><Type size={15} /><strong>字体大小</strong><small>{Math.round(settings.fontScale * 100)}%</small></header><div className="start-menu-segments">{FONT_SCALES.map((scale) => <button className={settings.fontScale === scale ? "active" : ""} type="button" key={scale} onClick={() => updateMenuSettings({ fontScale: scale })}>{Math.round(scale * 100)}%</button>)}</div></section>
            <section><header><Palette size={15} /><strong>界面主题</strong><small>{{ dark: "深色", light: "亮色", system: "跟随系统" }[settings.theme]}</small></header><div className="start-menu-segments">{(["dark", "light", "system"] as const).map((theme) => <button className={settings.theme === theme ? "active" : ""} type="button" key={theme} onClick={() => updateMenuSettings({ theme })}>{{ dark: "深色", light: "亮色", system: "跟随系统" }[theme]}</button>)}</div></section>
            <section><header><Languages size={15} /><strong>语言</strong><small>{locale === "en" ? "English" : "简体中文"}</small></header><div className="start-menu-segments" aria-label="语言"><button className={locale === "zh-CN" ? "active" : ""} type="button" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>简体中文</button><button className={locale === "en" ? "active" : ""} type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button></div></section>
            <section><header><Factory size={15} /><strong>科技树布局</strong><small>{settings.technologyLayout === "compact" ? "精简" : "标准"}</small></header><div className="start-menu-segments">{(["standard", "compact"] as const).map((technologyLayout) => <button className={settings.technologyLayout === technologyLayout ? "active" : ""} type="button" key={technologyLayout} onClick={() => updateMenuSettings({ technologyLayout })}>{technologyLayout === "compact" ? "精简模式" : "标准模式"}</button>)}</div></section>
            <section><header><Zap size={15} /><strong>模拟速度</strong><small>{settings.simulationSpeed}×</small></header><div className="start-menu-segments">{SIMULATION_SPEEDS.map((speed) => <button className={settings.simulationSpeed === speed ? "active" : ""} type="button" key={speed} onClick={() => updateMenuSettings({ simulationSpeed: speed })}>{speed}×</button>)}</div></section>
            <section><header><Clock3 size={15} /><strong>自动保存</strong><small>{settings.autosaveIntervalSeconds} 秒</small></header><div className="start-menu-segments">{AUTOSAVE_INTERVALS.map((seconds) => <button className={settings.autosaveIntervalSeconds === seconds ? "active" : ""} type="button" key={seconds} onClick={() => updateMenuSettings({ autosaveIntervalSeconds: seconds })}>{seconds} 秒</button>)}</div></section>
            <section className="start-menu-setting-toggles"><ToggleRow checked={settings.performanceMode} label="性能模式" value={settings.performanceMode ? "低频渲染" : "完整渲染"} icon={<Cpu size={16} />} onChange={(performanceMode) => updateMenuSettings({ performanceMode })} /><ToggleRow checked={settings.reducedMotion} label="减少动态效果" value={settings.reducedMotion ? "动态已精简" : "完整动态"} icon={<Gauge size={16} />} onChange={(reducedMotion) => updateMenuSettings({ reducedMotion })} /><ToggleRow checked={approximateOfflineExperiment} label={locale === "en" ? "Approximate offline settlement (experimental)" : "近似离线结算（实验）"} value={locale === "en" ? approximateOfflineExperiment ? "Two-window calibration with automatic exact fallback" : "Off · Full exact settlement" : approximateOfflineExperiment ? "双窗口校准，失败自动精确回退" : "关闭 · 使用完整精确结算"} icon={<Clock3 size={16} />} onChange={(enabled) => { setApproximateOfflineExperiment(enabled); setApproximateOfflineExperimentEnabled(enabled); }} /><ToggleRow checked={settings.soundEnabled} label="操作音效" value={settings.soundEnabled ? "已开启" : "已关闭"} icon={settings.soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />} onChange={(soundEnabled) => updateMenuSettings({ soundEnabled })} /><ToggleRow checked={settings.allowDoubleClickZoom} label="允许双击缩放" value={settings.allowDoubleClickZoom ? "双击聚焦画布" : "连续点击不缩放"} icon={<MousePointer2 size={16} />} onChange={(allowDoubleClickZoom) => updateMenuSettings({ allowDoubleClickZoom })} /></section>
            <NativeUpdateCard className="start-menu-native-update" />
            <section className="start-menu-release-notes"><header><History size={15} /><strong>版本更新记录</strong><small>{CURRENT_RELEASE_NOTES.date}</small></header><button type="button" onClick={onOpenReleaseNotes} aria-label={`查看${CURRENT_RELEASE_NOTES.date}版本更新记录`}><span><strong>{CURRENT_RELEASE_NOTES.title}</strong><small>{CURRENT_RELEASE_NOTES.items.length} 项体验更新</small></span><ArrowRight size={15} /></button></section>
            <section className="start-menu-community"><header><MessageCircle size={15} /><strong>QQ 交流群</strong><small>意见、建议与问题反馈</small></header><p>群号 <strong>1076757280</strong></p></section>
          </div> : null}

          {message ? <div className={`start-menu-message start-menu-message--${message.tone}`} role="status">{message.tone === "ready" ? <Check size={14} /> : <Activity size={14} />}<span>{message.text}</span></div> : null}
        </section>
      </section>

      <footer className="start-menu-footer"><span><i className="ready" />模拟核心按需载入</span><span><ShieldCheck size={12} />载入时校验存档</span><span>{window.isSecureContext ? "HTTPS" : "HTTP"} · {window.location.hostname || "Desktop"}</span></footer>
      <SaveDeleteDialog target={deleteRequest} onCancel={() => setDeleteRequest(null)} onDelete={() => {
        if (!deleteRequest) return;
        setBusy(true);
        void loadStorageModule().then(async ({ clearGameSlotVerified }) => {
          const removed = await clearGameSlotVerified(deleteRequest.slotId);
          if (!removed) throw new Error(`${deleteRequest.label}删除失败`);
          refreshLocalSaves();
          setMessage({ tone: "ready", text: `${deleteRequest.label}已删除，其他存档未受影响` });
          setDeleteRequest(null);
        }).finally(() => setBusy(false));
      }} />
    </main>
  );
}
