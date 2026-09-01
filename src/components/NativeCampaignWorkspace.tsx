import {
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  LockKeyhole,
  Route,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopNativeCampaignLocator,
  DesktopNativeCoreCampaignWorkspaceProjectionRequest,
  DesktopNativeCoreCampaignWorkspaceProjectionResult,
} from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "../game/campaign";
import { formatQuantityCompact } from "../game/quantityFormat";
import { WorkspaceFrame } from "./WorkspaceFrame";

type NativeCampaignStatus =
  | { phase: "loading" }
  | { phase: "ready"; projection: DesktopNativeCoreCampaignWorkspaceProjectionResult }
  | { phase: "unavailable"; message: string };

export interface NativeCampaignWorkspaceProps {
  open: boolean;
  identity: DesktopNativeCoreCampaignWorkspaceProjectionRequest | null;
  fetchProjection: ((request: DesktopNativeCoreCampaignWorkspaceProjectionRequest) => Promise<DesktopNativeCoreCampaignWorkspaceProjectionResult>) | null;
  onClose: () => void;
  onNavigate: (locator: DesktopNativeCampaignLocator, taskId: string) => void;
}

const CHAPTER_BY_ID = new Map(CAMPAIGN_CHAPTERS.map((chapter) => [chapter.id, chapter]));
const TASK_BY_ID = new Map(CAMPAIGN_TASKS.map((task) => [task.id, task]));

function identityMatches(
  projection: DesktopNativeCoreCampaignWorkspaceProjectionResult,
  identity: DesktopNativeCoreCampaignWorkspaceProjectionRequest,
): boolean {
  return projection.sessionId === identity.sessionId &&
    projection.runId === identity.runId &&
    projection.revision === identity.expectedRevision &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint;
}

function scopeMatches(
  projection: DesktopNativeCoreCampaignWorkspaceProjectionResult,
  identity: DesktopNativeCoreCampaignWorkspaceProjectionRequest,
): boolean {
  return projection.sessionId === identity.sessionId &&
    projection.runId === identity.runId &&
    projection.registryFingerprint === identity.expectedRegistryFingerprint;
}

function campaignIdentityKey(identity: DesktopNativeCoreCampaignWorkspaceProjectionRequest | null): string {
  return identity
    ? `${identity.sessionId}\u0000${identity.runId}\u0000${identity.expectedRevision}\u0000${identity.expectedRegistryFingerprint}`
    : "missing";
}

function catalogMatches(projection: DesktopNativeCoreCampaignWorkspaceProjectionResult): boolean {
  if (projection.truncated || projection.counts.chapters !== CAMPAIGN_CHAPTERS.length ||
      projection.counts.tasks !== CAMPAIGN_TASKS.length ||
      projection.chapters.length !== CAMPAIGN_CHAPTERS.length) return false;
  const taskIds = new Set<string>();
  for (const chapter of projection.chapters) {
    const definition = CHAPTER_BY_ID.get(chapter.id as never);
    if (!definition || chapter.totalCount !== definition.taskIds.length ||
        chapter.tasks.length !== definition.taskIds.length) return false;
    for (const task of chapter.tasks) {
      if (!definition.taskIds.includes(task.id as never) || !TASK_BY_ID.has(task.id as never) || taskIds.has(task.id)) return false;
      taskIds.add(task.id);
    }
  }
  return taskIds.size === CAMPAIGN_TASKS.length;
}

function unavailableMessage(identity: NativeCampaignWorkspaceProps["identity"], fetchProjection: NativeCampaignWorkspaceProps["fetchProjection"]): string {
  if (!identity) return "原生玩家权威 lineage 尚未就绪；任务页不会读取旧 Web 存档。";
  if (!fetchProjection) return "当前 Windows Host 不支持战役薄投影；任务页已安全关闭。";
  return "战役投影未通过当前 revision、run 或目录校验；任务页已安全关闭。";
}

export function NativeCampaignWorkspace({
  open,
  identity,
  fetchProjection,
  onClose,
  onNavigate,
}: NativeCampaignWorkspaceProps) {
  const [status, setStatus] = useState<NativeCampaignStatus>({ phase: "loading" });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const currentIdentityRef = useRef(identity);
  currentIdentityRef.current = identity;
  const identityKey = campaignIdentityKey(identity);

  useEffect(() => {
    if (!open) return;
    if (!identity || !fetchProjection) {
      setStatus({ phase: "unavailable", message: unavailableMessage(identity, fetchProjection) });
      return;
    }
    setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, identity) && catalogMatches(current.projection)
      ? current
      : { phase: "loading" });
    void fetchProjection(identity).then((projection) => {
      const currentIdentity = currentIdentityRef.current;
      if (!identityMatches(projection, identity) || !catalogMatches(projection)) {
        if (!currentIdentity || campaignIdentityKey(currentIdentity) !== campaignIdentityKey(identity)) return;
        setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity) && catalogMatches(current.projection)
          ? current
          : { phase: "unavailable", message: unavailableMessage(identity, fetchProjection) });
        return;
      }
      if (!currentIdentity || !scopeMatches(projection, currentIdentity) || projection.revision > currentIdentity.expectedRevision) return;
      setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity) &&
        catalogMatches(current.projection) && current.projection.revision >= projection.revision
        ? current
        : { phase: "ready", projection });
    }).catch(() => {
      const currentIdentity = currentIdentityRef.current;
      if (!currentIdentity || campaignIdentityKey(currentIdentity) !== campaignIdentityKey(identity)) return;
      setStatus((current) => current.phase === "ready" && scopeMatches(current.projection, currentIdentity) && catalogMatches(current.projection)
        ? current
        : { phase: "unavailable", message: unavailableMessage(identity, fetchProjection) });
    });
  }, [fetchProjection, identityKey, open]);

  const projection = status.phase === "ready" && identity &&
    scopeMatches(status.projection, identity) && catalogMatches(status.projection)
    ? status.projection
    : null;
  const activeChapter = useMemo(() => projection?.chapters.find((chapter) => chapter.id === projection.activeChapterId)
    ?? projection?.chapters[0] ?? null, [projection]);
  if (!open) return null;

  if (!projection) {
    return (
      <WorkspaceFrame className="campaign-workspace" ariaLabel="原生主线任务中心" onRequestClose={onClose}>
        <header className="campaign-header">
          <div className="campaign-title"><i><Flag size={20} /></i><div><span>RUST 权威</span><strong>主线任务中心</strong></div></div>
          <button className="campaign-close" type="button" onClick={onClose} aria-label="关闭任务中心"><X size={18} /></button>
        </header>
        <div className="workspace-loading" role={status.phase === "loading" ? "status" : "alert"}>
          {status.phase === "loading" ? <i /> : <ShieldAlert size={22} />}
          <span>{status.phase === "loading" ? "正在读取 Rust 权威任务进度…" : status.phase === "unavailable" ? status.message : "战役投影已失效"}</span>
        </div>
      </WorkspaceFrame>
    );
  }

  const completion = projection.counts.tasks > 0
    ? projection.counts.completedTasks / projection.counts.tasks * 100
    : 0;
  return (
    <WorkspaceFrame className="campaign-workspace native-campaign-workspace" ariaLabel="原生主线任务中心" onRequestClose={onClose}>
      <header className="campaign-header">
        <div className="campaign-title"><i><Flag size={20} /></i><div><span>RUST 权威 · REV {projection.revision}</span><strong>主线任务中心</strong></div></div>
        <div className="campaign-headline">
          <span>章节 <strong>{projection.chapters.filter((chapter) => chapter.complete).length}/{projection.counts.chapters}</strong></span>
          <span>任务 <strong>{projection.counts.completedTasks}/{projection.counts.tasks}</strong></span>
        </div>
        <button className="campaign-close" type="button" onClick={onClose} aria-label="关闭任务中心"><X size={18} /></button>
      </header>
      {identity && projection.revision !== identity.expectedRevision
        ? <p role="status" className="operations-notice">正在读取 Rust revision {identity.expectedRevision}；当前保持显示已验证的 revision {projection.revision}。</p>
        : null}
      <div className="campaign-progress-overview">
        <div><span>当前章节</span><strong>{activeChapter ? CHAPTER_BY_ID.get(activeChapter.id as never)?.name : "全部完成"}</strong><small>{activeChapter ? CHAPTER_BY_ID.get(activeChapter.id as never)?.summary : "生产网络可以继续自由扩展。"}</small></div>
        <div className="campaign-progress-meter" role="progressbar" aria-label="任务完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(completion)}><i><b style={{ width: `${completion}%` }} /></i><span>{Math.round(completion)}% 完成</span></div>
        <div className="campaign-now"><small>数据边界</small><strong>只读任务投影</strong><span>导航只提交界面定位，不选择任务、不改库存。</span></div>
      </div>
      <div className="campaign-chapter-list">
        {projection.chapters.map((chapter, chapterIndex) => {
          const chapterDefinition = CHAPTER_BY_ID.get(chapter.id as never)!;
          const isCollapsed = collapsed.has(chapter.id);
          return <section className={`campaign-chapter${chapter.id === projection.activeChapterId ? " campaign-chapter--active" : ""}${chapter.complete ? " campaign-chapter--complete" : ""}${isCollapsed ? " campaign-chapter--collapsed" : ""}`} key={chapter.id}>
            <button className="campaign-chapter-header" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id);
              return next;
            })}>
              <div className="campaign-chapter-index">{chapter.complete ? <Check size={15} /> : String(chapterIndex + 1).padStart(2, "0")}</div>
              <div><strong>{chapterDefinition.name}</strong><small>{chapterDefinition.summary}</small></div>
              <em>{chapter.completedCount}/{chapter.totalCount}</em><i className="campaign-chapter-chevron">{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</i>
            </button>
            {!isCollapsed ? <div className="campaign-task-list">{chapter.tasks.map((task) => {
              const definition = TASK_BY_ID.get(task.id as never)!;
              const width = task.progress.target > 0 ? Math.min(100, task.progress.current / task.progress.target * 100) : 0;
              return <article className={`campaign-task campaign-task--${task.status}`} key={task.id}>
                <div className="campaign-task-select">
                  <i>{task.status === "complete" ? <Check size={14} /> : task.status === "locked" ? <LockKeyhole size={13} /> : task.status === "active" ? <Flag size={13} /> : <span />}</i>
                  <span><strong>{definition.title}</strong><small>{definition.description}</small></span><em>{task.track === "main" ? "主线" : "支线"}</em>
                </div>
                <div className="campaign-task-detail">
                  <div className="campaign-task-progress"><i><b style={{ width: `${width}%` }} /></i><span>{formatQuantityCompact(task.progress.current)} / {formatQuantityCompact(task.progress.target)}</span></div>
                  <div className="campaign-task-meta">{task.locator ? <button className="campaign-route-command" type="button" onClick={() => onNavigate(task.locator!, task.id)}><Route size={13} />定位目标</button> : <span>此任务没有界面定位目标</span>}</div>
                </div>
              </article>;
            })}</div> : null}
          </section>;
        })}
      </div>
    </WorkspaceFrame>
  );
}
