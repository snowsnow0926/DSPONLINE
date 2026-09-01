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
import { useMemo, useState } from "react";
import type { DesktopNativeCampaignLocator } from "../desktop";
import { CAMPAIGN_CHAPTERS, CAMPAIGN_TASKS } from "../game/campaign";
import type {
  NativeCampaignGalaxyWorkspaceIdentity,
  NativeCampaignGalaxyWorkspaceReadStatus,
  NativeCampaignWorkspaceFrame,
} from "../game/nativeCampaignGalaxyWorkspaceStore";
import { formatQuantityCompact } from "../game/quantityFormat";
import { WorkspaceFrame } from "./WorkspaceFrame";

export interface NativeCampaignWorkspaceProps {
  open: boolean;
  frame: NativeCampaignWorkspaceFrame | null;
  latestIdentity: NativeCampaignGalaxyWorkspaceIdentity | null;
  status: NativeCampaignGalaxyWorkspaceReadStatus;
  onClose: () => void;
  onNavigate: (locator: DesktopNativeCampaignLocator, taskId: string) => void;
}

const CHAPTER_BY_ID = new Map(CAMPAIGN_CHAPTERS.map((chapter) => [chapter.id, chapter]));
const TASK_BY_ID = new Map(CAMPAIGN_TASKS.map((task) => [task.id, task]));

export function NativeCampaignWorkspace({
  open,
  frame: candidateFrame,
  latestIdentity,
  status,
  onClose,
  onNavigate,
}: NativeCampaignWorkspaceProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
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
  const activeChapter = useMemo(() => projection?.chapters.find((chapter) => chapter.id === projection.activeChapterId)
    ?? projection?.chapters[0] ?? null, [projection]);
  if (!open) return null;

  if (!projection) {
    return (
      <WorkspaceFrame className="campaign-workspace" ariaLabel="原生主线任务中心" onRequestClose={onClose}
        data-native-campaign-status={status}>
        <header className="campaign-header">
          <div className="campaign-title"><i><Flag size={20} /></i><div><span>RUST 权威</span><strong>主线任务中心</strong></div></div>
          <button className="campaign-close" type="button" onClick={onClose} aria-label="关闭任务中心"><X size={18} /></button>
        </header>
        <div className="workspace-loading" role={status === "empty" || status === "loading" ? "status" : "alert"}>
          {status === "empty" || status === "loading" ? <i /> : <ShieldAlert size={22} />}
          <span>{status === "empty" || status === "loading"
            ? "正在读取 Rust 权威任务进度…"
            : "战役投影未通过当前 revision、run 或目录校验；任务页已安全关闭。"}</span>
        </div>
      </WorkspaceFrame>
    );
  }

  const completion = projection.counts.tasks > 0
    ? projection.counts.completedTasks / projection.counts.tasks * 100
    : 0;
  return (
    <WorkspaceFrame className="campaign-workspace native-campaign-workspace" ariaLabel="原生主线任务中心" onRequestClose={onClose}
      data-native-campaign-status={exactFrame ? "ready" : status}
      data-native-campaign-revision={projection.revision}
      data-native-campaign-display-stale={exactFrame ? undefined : "true"}>
      <header className="campaign-header">
        <div className="campaign-title"><i><Flag size={20} /></i><div><span>RUST 权威 · REV {projection.revision}</span><strong>主线任务中心</strong></div></div>
        <div className="campaign-headline">
          <span>章节 <strong>{projection.chapters.filter((chapter) => chapter.complete).length}/{projection.counts.chapters}</strong></span>
          <span>任务 <strong>{projection.counts.completedTasks}/{projection.counts.tasks}</strong></span>
        </div>
        <button className="campaign-close" type="button" onClick={onClose} aria-label="关闭任务中心"><X size={18} /></button>
      </header>
      {!exactFrame && latestIdentity
        ? <p role="status" className="operations-notice">{status === "unavailable"
          ? `Rust revision ${latestIdentity.revision} 暂不可用`
          : `正在读取 Rust revision ${latestIdentity.revision}`}；当前保持显示已验证的 revision {projection.revision}。</p>
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
