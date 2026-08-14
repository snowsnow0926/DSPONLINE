import { CloudDownload, CloudUpload, HardDrive, History, LoaderCircle, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearCloudSyncMarker,
  deleteCloudSave,
  downloadCloudSave,
  fetchCloudSaveHistory,
  markCloudSaveSynchronized,
  resumeCloudSession,
  restoreCloudSaveRevision,
  type CloudSaveMetadata,
  type CloudSaveMode,
  type CloudSaveSlot,
} from "../game/cloud";
import { getMenuContinueSave, getMenuSlotSummaries } from "../game/savePreview";
import type { SaveSlotId } from "../game/storage";
import {
  CLOUD_SAVE_MODE_OPTIONS,
  cloudRestoreTargetIssue,
  cloudSaveModeLabel,
  cloudSaveSlotLabel,
} from "./cloudSaveRecovery";
import { AccessibleDialog } from "./AccessibleDialog";
import "./cloud-save-recovery.css";

const resolveMenuContinueSave = (mode: CloudSaveMode) => import("../game/savePreviewPayload").then((module) => module.resolveMenuContinueSave(mode));
const readMenuSavePayload = (key: string) => import("../game/savePreviewPayload").then((module) => module.readMenuSavePayload(key));

interface LocalCloudSlotSummary {
  slotId: SaveSlotId;
  valid: boolean;
  savedAt: number;
  elapsedSeconds: number;
  completedTechCount: number;
}

interface CloudSaveSlotsPanelProps {
  mode?: CloudSaveMode;
  cloudSaves?: Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>;
  cloudSavesByMode?: Partial<Record<CloudSaveMode, Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>>>;
  localSlots: LocalCloudSlotSummary[];
  busySlot?: CloudSaveSlot | null;
  uploadDisabled?: boolean;
  onUpload: (slot: Exclude<CloudSaveSlot, "main">) => void;
  onDownload: (slot: Exclude<CloudSaveSlot, "main">) => void;
  onDelete?: (slot: Exclude<CloudSaveSlot, "main">, cloud: CloudSaveMetadata) => void;
}

const MANUAL_SLOTS = ["1", "2", "3"] as const;

type PendingCloudAction =
  | { kind: "download"; mode: CloudSaveMode; slot: CloudSaveSlot; metadata: CloudSaveMetadata; revision?: number; localExists: boolean }
  | { kind: "restore-history"; mode: CloudSaveMode; slot: CloudSaveSlot; metadata: CloudSaveMetadata; revision: number }
  | { kind: "delete"; mode: CloudSaveMode; slot: CloudSaveSlot; metadata: CloudSaveMetadata };

interface RecoveryNotice {
  tone: "ready" | "warning" | "error";
  text: string;
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未保存";
}

function formatProgress(seconds: number | undefined, completedTechCount: number | undefined): string {
  if (seconds == null) return "无进度摘要";
  const hours = Math.floor(Math.max(0, seconds) / 3600);
  const minutes = Math.floor((Math.max(0, seconds) % 3600) / 60);
  return `${hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分钟`} · 科技 ${completedTechCount ?? 0}`;
}

function normalizeModeSaves(
  mode: CloudSaveMode,
  currentMode: CloudSaveMode,
  cloudSaves: CloudSaveSlotsPanelProps["cloudSaves"],
  cloudSavesByMode: CloudSaveSlotsPanelProps["cloudSavesByMode"],
): Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>> {
  const selected = cloudSavesByMode?.[mode] ?? (mode === currentMode ? cloudSaves : undefined) ?? {};
  return Object.fromEntries(Object.entries(selected).map(([slot, metadata]) => [slot, metadata ? { ...metadata, mode, slot } : null]));
}

function localSummary(mode: CloudSaveMode, slot: CloudSaveSlot, currentMode: CloudSaveMode, localSlots: LocalCloudSlotSummary[], forcePreview = false) {
  if (forcePreview || mode !== currentMode) {
    if (slot === "main") return getMenuContinueSave(mode)?.summary ?? null;
    return getMenuSlotSummaries(mode).find((candidate) => candidate.slotId === Number(slot)) ?? null;
  }
  if (slot === "main") return getMenuContinueSave(mode)?.summary ?? null;
  return localSlots.find((candidate) => candidate.slotId === Number(slot) as SaveSlotId) ?? null;
}

export function CloudSaveSlotsPanel({ mode = "normal", cloudSaves, cloudSavesByMode, localSlots, busySlot = null, uploadDisabled = false, onUpload, onDownload, onDelete }: CloudSaveSlotsPanelProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null);
  const discoveryRequestRef = useRef(0);
  const [recoverySurface, setRecoverySurface] = useState(false);
  const [selectedMode, setSelectedMode] = useState<CloudSaveMode>(mode);
  const [discoveredByMode, setDiscoveredByMode] = useState<Partial<Record<CloudSaveMode, Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>>>>(() => ({
    ...cloudSavesByMode,
    [mode]: normalizeModeSaves(mode, mode, cloudSaves, cloudSavesByMode),
  }));
  const [loadingMode, setLoadingMode] = useState<CloudSaveMode | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [historySlot, setHistorySlot] = useState<CloudSaveSlot | null>(null);
  const [history, setHistory] = useState<CloudSaveMetadata[]>([]);
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingCloudAction | null>(null);
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);

  useEffect(() => {
    setDiscoveredByMode((current) => ({
      ...current,
      ...cloudSavesByMode,
      [mode]: normalizeModeSaves(mode, mode, cloudSaves, cloudSavesByMode),
    }));
  }, [cloudSaves, cloudSavesByMode, mode]);

  useEffect(() => {
    setRecoverySurface(Boolean(rootRef.current?.closest(".start-menu")));
  }, []);

  useEffect(() => {
    if (recoverySurface) return;
    setSelectedMode(mode);
    setHistorySlot(null);
    setHistory([]);
    setPendingAction(null);
    setNotice(null);
  }, [mode, recoverySurface]);

  const activeMode = recoverySurface ? selectedMode : mode;
  const selectedSaves = recoverySurface
    ? discoveredByMode[activeMode] ?? {}
    : normalizeModeSaves(mode, mode, cloudSaves, cloudSavesByMode);
  const modeLabel = cloudSaveModeLabel(activeMode);
  const selectedSlots = useMemo(() => ["main", ...MANUAL_SLOTS] as const, []);
  const externallyBusy = Boolean(busySlot);

  const discoverMode = async (nextMode: CloudSaveMode) => {
    const requestId = ++discoveryRequestRef.current;
    setSelectedMode(nextMode);
    setHistorySlot(null);
    setHistory([]);
    setNotice(null);
    setLoadingMode(nextMode);
    try {
      const session = await resumeCloudSession(nextMode);
      if (requestId !== discoveryRequestRef.current) return;
      if (session.status !== "authenticated" || !session.user) {
        throw new Error(session.message ?? "云账户登录已失效，请重新登录");
      }
      setCloudUserId(session.user.id);
      const metadata = normalizeModeSaves(nextMode, nextMode, session.cloudSaves, session.cloudSavesByMode);
      setDiscoveredByMode((current) => ({
        ...current,
        ...session.cloudSavesByMode,
        [nextMode]: Object.fromEntries(selectedSlots.map((slot) => [slot, metadata[slot] ?? null])),
      }));
    } catch (error) {
      if (requestId === discoveryRequestRef.current) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : `${cloudSaveModeLabel(nextMode)}云存档发现失败` });
      }
    } finally {
      if (requestId === discoveryRequestRef.current) setLoadingMode(null);
    }
  };

  const updateMetadata = (targetMode: CloudSaveMode, slot: CloudSaveSlot, metadata: CloudSaveMetadata | null) => {
    setDiscoveredByMode((current) => ({
      ...current,
      [targetMode]: { ...current[targetMode], [slot]: metadata ? { ...metadata, mode: targetMode, slot } : null },
    }));
  };

  const openHistory = async (slot: CloudSaveSlot) => {
    if (historySlot === slot) {
      setHistorySlot(null);
      setHistory([]);
      return;
    }
    setPanelBusy(true);
    setNotice(null);
    try {
      const entries = await fetchCloudSaveHistory(slot, activeMode);
      setHistory(entries);
      setHistorySlot(slot);
      if (entries.length === 0) setNotice({ tone: "warning", text: `${cloudSaveSlotLabel(activeMode, slot)}没有历史修订` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${cloudSaveSlotLabel(activeMode, slot)}历史读取失败` });
    } finally {
      setPanelBusy(false);
    }
  };

  const restoreDownloadedSave = async (action: Extract<PendingCloudAction, { kind: "download" }>) => {
    const cloudSave = await downloadCloudSave(action.revision, action.slot, action.mode);
    if (!cloudSave) throw new Error(`${cloudSaveSlotLabel(action.mode, action.slot)}为空`);
    const storage = await import("../game/storage");
    const inspection = storage.inspectSave(cloudSave.payload);
    const issue = cloudRestoreTargetIssue(inspection, cloudSave, action.mode, action.slot);
    if (issue || !inspection.state) throw new Error(issue ?? "云存档正文无效");

    const localSlotKey = action.slot === "main"
      ? null
      : getMenuSlotSummaries(action.mode).find((entry) => entry.slotId === Number(action.slot))?.key ?? null;
    const existingRaw = action.slot === "main"
      ? (await resolveMenuContinueSave(action.mode))?.raw ?? null
      : localSlotKey ? await readMenuSavePayload(localSlotKey) : null;
    if (existingRaw) {
      const existingInspection = storage.inspectSave(existingRaw);
      if (!existingInspection.valid || !existingInspection.state || existingInspection.mode !== action.mode) {
        throw new Error(`本机${cloudSaveSlotLabel(action.mode, action.slot)}无法创建安全快照，已取消写入`);
      }
      const snapshot = await storage.saveGameSnapshotVerified(existingInspection.state, `恢复${cloudSaveSlotLabel(action.mode, action.slot)}前`);
      if (!snapshot) throw new Error(`无法创建${cloudSaveModeLabel(action.mode)}恢复快照，已取消写入`);
    }

    const result = action.slot === "main"
      ? await storage.saveVerifiedPayload(cloudSave.payload, { mode: action.mode })
      : await storage.saveGameSlotVerified(Number(action.slot) as SaveSlotId, inspection.state);
    if (!result.success) throw new Error(result.message);
    if (cloudUserId) markCloudSaveSynchronized(cloudUserId, cloudSave, cloudSave.payload, action.slot, action.mode);
    setNotice({
      tone: "ready",
      text: `${cloudSaveSlotLabel(action.mode, action.slot)}已恢复到本机；${action.mode === "speedrun" ? "未创建或改写普通模式存档" : "速通模式存档未受影响"}`,
    });
  };

  const requestDownload = (slot: CloudSaveSlot, cloud: CloudSaveMetadata) => {
    if (!recoverySurface && slot !== "main") {
      onDownload(slot);
      return;
    }
    setPendingAction({
      kind: "download",
      mode: activeMode,
      slot,
      metadata: cloud,
      localExists: Boolean(localSummary(activeMode, slot, mode, localSlots)),
    });
  };

  const requestDelete = (slot: Exclude<CloudSaveSlot, "main">, cloud: CloudSaveMetadata) => {
    if (!recoverySurface && onDelete) {
      onDelete(slot, { ...cloud, mode: activeMode, slot });
      return;
    }
    setPendingAction({ kind: "delete", mode: activeMode, slot, metadata: cloud });
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPanelBusy(true);
    setNotice(null);
    try {
      if (action.kind === "download") {
        await restoreDownloadedSave(action);
      } else if (action.kind === "restore-history") {
        const restored = await restoreCloudSaveRevision(action.revision, action.metadata.revision, action.slot, action.mode);
        updateMetadata(action.mode, action.slot, restored);
        if (cloudUserId) clearCloudSyncMarker(cloudUserId, action.slot, action.mode);
        setHistory(await fetchCloudSaveHistory(action.slot, action.mode));
        setNotice({ tone: "ready", text: `${cloudSaveSlotLabel(action.mode, action.slot)}修订 ${action.revision} 已恢复为新修订 ${restored.revision}` });
      } else {
        await deleteCloudSave(action.slot, action.metadata.revision, action.mode);
        updateMetadata(action.mode, action.slot, null);
        if (cloudUserId) clearCloudSyncMarker(cloudUserId, action.slot, action.mode);
        setHistorySlot(null);
        setHistory([]);
        setNotice({ tone: "ready", text: `${cloudSaveSlotLabel(action.mode, action.slot)}已删除；另一模式和其他槽位未受影响` });
      }
      setPendingAction(null);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : `${cloudSaveSlotLabel(action.mode, action.slot)}操作失败` });
      setPendingAction(null);
    } finally {
      setPanelBusy(false);
    }
  };

  return <section ref={rootRef} className={`cloud-manual-slots${recoverySurface ? " cloud-save-recovery" : ""}`} aria-label={recoverySurface ? "按模式管理云存档" : "云端手动存档槽位"}>
    <header>
      <HardDrive size={16} />
      <span><strong>{recoverySurface ? "按模式管理云存档" : `${modeLabel} · 手动云存档`}</strong><small>{recoverySurface ? "选择器只读取对应命名空间，不会触发上传、自动同步或跨模式写入" : "槽位 1–3 与其他模式及主存档完全独立，自动同步不会覆盖"}</small></span>
      {recoverySurface ? <div className="cloud-save-mode-selector" role="radiogroup" aria-label="云存档模式">
        {CLOUD_SAVE_MODE_OPTIONS.map((option) => <button className={selectedMode === option.mode ? "active" : ""} type="button" role="radio" aria-checked={selectedMode === option.mode} disabled={panelBusy || externallyBusy} onClick={() => void discoverMode(option.mode)} key={option.mode}><strong>{option.label}</strong><small>{option.description}</small></button>)}
      </div> : null}
    </header>
    {recoverySurface && loadingMode ? <p className="cloud-save-recovery-status"><LoaderCircle size={14} />正在发现{cloudSaveModeLabel(loadingMode)}云存档…</p> : null}
    {recoverySurface && notice ? <p className={`cloud-save-recovery-status cloud-save-recovery-status--${notice.tone}`} role="status">{notice.tone === "ready" ? <ShieldCheck size={14} /> : <HardDrive size={14} />}{notice.text}</p> : null}
    {recoverySurface ? <section className="cloud-save-primary-recovery" data-cloud-slot="main">
      {(() => {
        const cloud = selectedSaves.main ?? null;
        const local = localSummary(activeMode, "main", mode, localSlots, recoverySurface);
        return <>
          <header><i>M</i><span><strong>{cloudSaveSlotLabel(activeMode, "main")}</strong><small>{formatTime(cloud?.updatedAt)}</small></span><em>{cloud ? `修订 ${cloud.revision}` : "云端为空"}</em></header>
          <dl><div><dt>本机主档</dt><dd>{local ? `${formatTime(local.savedAt)} · ${formatProgress(local.elapsedSeconds, local.completedTechCount)}` : "本机没有该模式主档"}</dd></div><div><dt>云端进度</dt><dd>{cloud?.summary ? formatProgress(cloud.summary.elapsedSeconds, cloud.summary.completedTechCount) : cloud ? "旧存档摘要待刷新" : "尚未建立"}</dd></div></dl>
          {activeMode === "speedrun" && cloud && !local ? <p className="cloud-save-discovery-callout"><ShieldCheck size={14} /><span><strong>发现新设备可恢复的速通主档</strong><small>明确确认后只写入速通模式主档，不创建普通工厂。</small></span></p> : null}
          <footer><button className="primary" type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => cloud && requestDownload("main", cloud)}><CloudDownload size={13} />{local ? "恢复到本机" : activeMode === "speedrun" ? "恢复速通主档" : "恢复普通主档"}</button><button type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => void openHistory("main")}><History size={13} />历史</button><button className="danger" type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => cloud && setPendingAction({ kind: "delete", mode: activeMode, slot: "main", metadata: cloud })}><Trash2 size={13} />删除</button></footer>
        </>;
      })()}
    </section> : null}
    {recoverySurface ? <header className="cloud-save-manual-heading"><HardDrive size={15} /><span><strong>{modeLabel} · 手动云存档</strong><small>槽位 1–3 与主存档及另一模式完全独立</small></span></header> : null}
    <div>
      {MANUAL_SLOTS.map((slot) => {
        const local = localSummary(activeMode, slot, mode, localSlots, recoverySurface);
        const cloud = selectedSaves[slot] ?? null;
        const useParentActions = activeMode === mode;
        const localSlotValid = Boolean(local && "valid" in local && local.valid);
        return <article className={!local && !cloud ? "empty" : ""} key={`${activeMode}-${slot}`} data-cloud-slot={slot}>
          <header><i>{slot}</i><span><strong>{cloudSaveSlotLabel(activeMode, slot)}</strong><small>{formatTime(cloud?.updatedAt)}</small></span><em>{cloud ? `修订 ${cloud.revision}` : "空"}</em></header>
          <dl><div><dt>本地槽位</dt><dd>{local ? `${formatTime(local.savedAt)} · ${formatProgress(local.elapsedSeconds, local.completedTechCount)}` : "空槽位"}</dd></div><div><dt>云端进度</dt><dd>{cloud?.summary ? formatProgress(cloud.summary.elapsedSeconds, cloud.summary.completedTechCount) : cloud ? "旧存档摘要待刷新" : "空槽位"}</dd></div></dl>
          <footer>
            <button type="button" disabled={panelBusy || externallyBusy || uploadDisabled || !localSlotValid || !useParentActions} onClick={() => onUpload(slot)} title={!useParentActions ? `请进入${modeLabel}工厂后上传，避免跨模式写入` : !local ? `${modeLabel}本地槽位 ${slot} 为空` : `上传${cloudSaveSlotLabel(activeMode, slot)}`}><CloudUpload size={13} />上传</button>
            <button type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => cloud && requestDownload(slot, cloud)}><CloudDownload size={13} />下载</button>
            {recoverySurface ? <button type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => void openHistory(slot)}><History size={13} />历史</button> : null}
            <button className="danger" type="button" disabled={panelBusy || externallyBusy || !cloud} onClick={() => cloud && requestDelete(slot, cloud)} title={`删除${cloudSaveSlotLabel(activeMode, slot)}`} aria-label={`删除${cloudSaveSlotLabel(activeMode, slot)}`}><Trash2 size={13} />删除</button>
          </footer>
        </article>;
      })}
    </div>
    {recoverySurface && historySlot && history.length > 0 ? <section className="cloud-save-recovery-history" aria-label={`${cloudSaveSlotLabel(activeMode, historySlot)}历史修订`}><header><History size={14} /><span><strong>{cloudSaveSlotLabel(activeMode, historySlot)} · 历史修订</strong><small>下载到本机或恢复为云端当前版本前均需明确确认</small></span><button type="button" aria-label="关闭云存档历史" onClick={() => { setHistorySlot(null); setHistory([]); }}><X size={13} /></button></header><div>{history.map((entry) => <article key={entry.revision}><span><strong>{cloudSaveSlotLabel(activeMode, historySlot)} · 修订 {entry.revision}</strong><small>{formatTime(entry.updatedAt)}</small></span><em>{entry.revision === selectedSaves[historySlot]?.revision ? "当前" : `${Math.max(0, entry.size / 1024).toFixed(1)} KB`}</em><button type="button" disabled={panelBusy} onClick={() => setPendingAction({ kind: "download", mode: activeMode, slot: historySlot, metadata: entry, revision: entry.revision, localExists: Boolean(localSummary(activeMode, historySlot, mode, localSlots, true)) })}><CloudDownload size={13} />下载</button><button type="button" disabled={panelBusy || entry.revision === selectedSaves[historySlot]?.revision} onClick={() => setPendingAction({ kind: "restore-history", mode: activeMode, slot: historySlot, metadata: selectedSaves[historySlot] ?? entry, revision: entry.revision })}><RotateCcw size={13} />恢复云端</button></article>)}</div></section> : null}
    {recoverySurface && pendingAction ? <AccessibleDialog
      open
      role="alertdialog"
      riskPolicy="explicit"
      className="cloud-save-recovery-confirm"
      title={`确认${cloudSaveSlotLabel(pendingAction.mode, pendingAction.slot)}${pendingAction.kind === "delete" ? "删除" : pendingAction.kind === "download" && pendingAction.localExists ? "覆盖" : "恢复"}`}
      description="请核对本次唯一目标；操作不会跨模式或跨槽位。"
      initialFocusRef={confirmationCancelRef}
      onRequestClose={() => { if (!panelBusy) setPendingAction(null); }}
      actions={<>
        <button ref={confirmationCancelRef} type="button" disabled={panelBusy} onClick={() => setPendingAction(null)}>取消</button>
        <button className={pendingAction.kind === "delete" ? "danger" : "primary"} type="button" disabled={panelBusy} onClick={() => void executePendingAction()}>{panelBusy ? <LoaderCircle size={14} /> : pendingAction.kind === "delete" ? <Trash2 size={14} /> : <ShieldCheck size={14} />}确认{pendingAction.kind === "delete" ? "删除" : pendingAction.kind === "download" && pendingAction.localExists ? "覆盖" : "恢复"}</button>
      </>}
    >
      <div className="cloud-save-recovery-confirm-target"><span>本次唯一目标</span><strong>{cloudSaveSlotLabel(pendingAction.mode, pendingAction.slot)}</strong><small>修订 {pendingAction.kind === "restore-history" || pendingAction.kind === "download" && pendingAction.revision !== undefined ? pendingAction.revision : pendingAction.metadata.revision} · {formatTime(pendingAction.metadata.updatedAt)}</small></div>
      <p>{pendingAction.kind === "delete" ? "只删除上方模式和槽位的云存档；另一模式、本机存档及其他槽位不会受到影响。" : pendingAction.kind === "restore-history" ? "只在上方模式与槽位创建一个新的云端修订；不会写入另一模式。" : pendingAction.localExists ? `本机${cloudSaveSlotLabel(pendingAction.mode, pendingAction.slot)}已有存档；确认后会先创建同模式恢复快照，再只覆盖这个本机目标。${pendingAction.mode === "speedrun" ? "普通存档不会受到影响。" : "速通存档不会受到影响。"}` : `只写入本机${cloudSaveSlotLabel(pendingAction.mode, pendingAction.slot)}；${pendingAction.mode === "speedrun" ? "不会创建普通存档，也不会把普通存档转换为速通。" : "速通存档不会受到影响。"}`}</p>
    </AccessibleDialog> : null}
  </section>;
}
