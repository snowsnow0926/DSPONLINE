import { CloudDownload, CloudUpload, Download, GitCompareArrows, LoaderCircle, X } from "lucide-react";
import { useRef } from "react";
import type { CloudSaveMetadata, CloudSaveSlot, CloudSaveSummary } from "../game/cloud";
import { AccessibleDialog } from "./AccessibleDialog";

interface CloudSaveConflictDialogProps {
  local: CloudSaveSummary | null;
  cloud: CloudSaveMetadata;
  slot: CloudSaveSlot;
  feedback?: string | null;
  busy?: boolean;
  onUseCloud: () => void;
  onKeepLocal: () => void;
  onExportLocal?: () => void;
  onExportCloud?: () => void;
  onCancel: () => void;
}

function formatRuntime(seconds: number | undefined): string {
  const hours = Math.floor(Math.max(0, seconds ?? 0) / 3600);
  const minutes = Math.floor((Math.max(0, seconds ?? 0) % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "未知";
}

function modeLabel(mode: CloudSaveSummary["mode"]): string {
  return mode === "speedrun" ? "速通模式" : "普通模式";
}

function slotLabel(slot: CloudSaveSlot): string {
  return slot === "main" ? "主存档" : `槽位 ${slot}`;
}

function Summary({ title, summary, revision, mode }: { title: string; summary: CloudSaveSummary | null; revision?: number; mode?: CloudSaveSummary["mode"] }) {
  return <section aria-label={title}>
    <header><strong>{title}</strong><small>{revision ? `修订 ${revision}` : "本地"}</small></header>
    <dl>
      <div><dt>存档模式</dt><dd>{modeLabel(mode ?? summary?.mode)}</dd></div>
      <div><dt>保存时间</dt><dd>{formatTime(summary?.savedAt)}</dd></div>
      <div><dt>运行时间</dt><dd>{formatRuntime(summary?.elapsedSeconds)}</dd></div>
      <div><dt>设备</dt><dd>{summary?.entityCount ?? "--"}</dd></div>
      <div><dt>科技</dt><dd>{summary?.completedTechCount ?? "--"}</dd></div>
    </dl>
  </section>;
}

export function CloudSaveConflictDialog({ local, cloud, slot, feedback, busy = false, onUseCloud, onKeepLocal, onExportLocal, onExportCloud, onCancel }: CloudSaveConflictDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const targetMode = cloud.mode ?? local?.mode ?? "normal";
  const targetLabel = `${modeLabel(targetMode)} · ${slotLabel(slot)}`;
  return <AccessibleDialog
    open
    role="alertdialog"
    riskPolicy="explicit"
    title={<><GitCompareArrows aria-hidden="true" size={19} /> 本地与云端都有不同进度</>}
    description={`${targetLabel}：请选择本次保留方向，另一份会保留为恢复点`}
    initialFocusRef={cancelButtonRef}
    onRequestClose={onCancel}
    actions={<>
      <button ref={cancelButtonRef} type="button" disabled={busy} onClick={onCancel}><X aria-hidden="true" size={14} />稍后处理</button>
      {onExportLocal ? <button type="button" disabled={busy} onClick={onExportLocal}><Download aria-hidden="true" size={14} />导出本地副本</button> : null}
      {onExportCloud ? <button type="button" disabled={busy} onClick={onExportCloud}><Download aria-hidden="true" size={14} />导出云端副本</button> : null}
      <button type="button" disabled={busy} onClick={onUseCloud}>{busy ? <LoaderCircle aria-hidden="true" size={14} /> : <CloudDownload aria-hidden="true" size={14} />}使用云端版本</button>
      <button className="primary" type="button" disabled={busy} onClick={onKeepLocal}>{busy ? <LoaderCircle aria-hidden="true" size={14} /> : <CloudUpload aria-hidden="true" size={14} />}保留本地并新建云修订</button>
    </>}
  >
    <p className="cloud-save-conflict-target"><strong>本次唯一目标</strong><span>{targetLabel}</span></p>
    {feedback ? <p className="cloud-save-conflict-feedback" role="status">{feedback}</p> : null}
    <div className="cloud-save-conflict-comparison">
      <Summary title="当前本地工厂" summary={local} />
      <Summary title="云端工厂" summary={cloud.summary} revision={cloud.revision} mode={cloud.mode} />
    </div>
  </AccessibleDialog>;
}
