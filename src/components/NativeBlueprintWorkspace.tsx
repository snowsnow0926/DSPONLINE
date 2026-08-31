import {
  BoxSelect,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Layers3,
  ListChecks,
  LockKeyhole,
  MapPin,
  Network,
  PencilLine,
  FlipHorizontal,
  RotateCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { canonicalizeNativeBlueprintName } from "../game/nativeBlueprintRenameIntentCommands";
import { NATIVE_BLUEPRINT_PAGE_ROWS } from "../game/nativeBlueprintWorkspaceStore";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintMirror,
  NativeBlueprintRenameIdentity,
  NativeBlueprintRotation,
  NativeBlueprintTransformBinding,
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceIdentity,
  NativeBlueprintWorkspaceSnapshot,
  NativeConstructionQueueCancelBinding,
} from "../game/nativeBlueprintWorkspaceStore";
import type {
  NativeBlueprintTransformPendingCommand,
} from "../game/nativeBlueprintTransformCommandReconciliation";
import type {
  NativeBlueprintDeletePendingCommand,
} from "../game/nativeBlueprintDeleteCommandReconciliation";
import type {
  NativeConstructionQueueCancelPendingCommand,
} from "../game/nativeConstructionQueueCancelCommandReconciliation";
import {
  nativeBlueprintRenameEditorTargetState,
  type NativeBlueprintRenamePendingIdentity,
  type NativeBlueprintRenameResolution,
  type NativeBlueprintRenameSubmitOutcome,
} from "../game/nativeBlueprintRenameWorkflow";
import { WorkspaceFrame } from "./WorkspaceFrame";

export type NativeBlueprintWorkspaceReadStatus = NativeBlueprintWorkspaceSnapshot["status"];

export interface NativeBlueprintWorkspaceProps {
  open: boolean;
  status: NativeBlueprintWorkspaceReadStatus;
  frame: NativeBlueprintWorkspaceFrame | null;
  latestIdentity: NativeBlueprintWorkspaceIdentity | null;
  onClose: () => void;
  onSelectBlueprint: (blueprintId: string) => void;
  onLibraryCursorChange: (cursor: number) => void;
  onQueueCursorChange: (cursor: number) => void;
  onSubmitRenameIntent: (
    identity: NativeBlueprintRenameIdentity,
    name: string,
  ) => NativeBlueprintRenameSubmitOutcome;
  onSubmitTransformIntent: (
    binding: NativeBlueprintTransformBinding,
    rotation: NativeBlueprintRotation,
    mirror: NativeBlueprintMirror,
  ) => boolean;
  onSubmitDeleteIntent: (binding: NativeBlueprintDeleteBinding) => boolean;
  onSubmitQueueCancelIntent: (binding: NativeConstructionQueueCancelBinding) => boolean;
  pendingIdentity: NativeBlueprintRenamePendingIdentity | null;
  transformPending: NativeBlueprintTransformPendingCommand | null;
  deletePending: NativeBlueprintDeletePendingCommand | null;
  queueCancelPending: NativeConstructionQueueCancelPendingCommand | null;
  resolution: NativeBlueprintRenameResolution | null;
  onConsumeRenameResolution: (submissionId: number) => void;
  commandPending: boolean;
}

const DETAIL_PREVIEW_ROWS = 24;

function formatSimulationTime(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function transformLabel(rotation: number, mirror: "none" | "horizontal"): string {
  return `${rotation}°${mirror === "horizontal" ? " · 水平镜像" : ""}`;
}

function nativeFrameIsComplete(
  frame: NativeBlueprintWorkspaceFrame | null,
  status: NativeBlueprintWorkspaceReadStatus,
): frame is NativeBlueprintWorkspaceFrame {
  if (!frame || status !== "ready" || frame.source !== "native-core" || frame.readOnly !== true) return false;
  for (const [rows, page] of [
    [frame.library, frame.libraryPage],
    [frame.queue, frame.queuePage],
  ] as const) {
    if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
        !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.cursor > page.totalCount ||
        rows.length > NATIVE_BLUEPRINT_PAGE_ROWS ||
        rows.length !== Math.min(NATIVE_BLUEPRINT_PAGE_ROWS, page.totalCount - page.cursor)) return false;
    const consumed = page.cursor + rows.length;
    if (page.nextCursor !== (consumed < page.totalCount ? consumed : null)) return false;
  }
  if (frame.selectedBlueprintId === null) return frame.detail === null;
  return frame.library.some((summary) => summary.id === frame.selectedBlueprintId) &&
    frame.detail?.summary.id === frame.selectedBlueprintId;
}

function NativeBlueprintPagination({
  section,
  cursor,
  totalCount,
  nextCursor,
  rowCount,
  locked,
  onCursorChange,
}: {
  section: "library" | "queue";
  cursor: number;
  totalCount: number;
  nextCursor: number | null;
  rowCount: number;
  locked: boolean;
  onCursorChange: (cursor: number) => void;
}) {
  const label = section === "library" ? "蓝图库" : "施工队列";
  const first = rowCount === 0 ? 0 : cursor + 1;
  const last = cursor + rowCount;
  return <nav
    className="blueprint-tabs native-blueprint-pagination"
    style={{ gridColumn: "1 / -1" }}
    aria-label={`${label}分页`}
    data-native-blueprint-pagination={section}
  >
    <button
      type="button"
      disabled={locked || cursor === 0}
      onClick={() => onCursorChange(Math.max(0, cursor - NATIVE_BLUEPRINT_PAGE_ROWS))}
      aria-label={`${label}上一页`}
      data-native-blueprint-action={`page-${section}-prev`}
    ><ChevronLeft size={14} />上一页</button>
    <span data-native-blueprint-page-range={section}>第 {first}–{last} 项 / 共 {totalCount} 项</span>
    <button
      type="button"
      disabled={locked || nextCursor === null}
      onClick={() => { if (nextCursor !== null) onCursorChange(nextCursor); }}
      aria-label={`${label}下一页`}
      data-native-blueprint-action={`page-${section}-next`}
    >下一页<ChevronRight size={14} /></button>
  </nav>;
}

function DetailOverflow({ total }: { total: number }) {
  if (total <= DETAIL_PREVIEW_ROWS) return null;
  return <span className="blueprint-composition-more">其余 {total - DETAIL_PREVIEW_ROWS} 项由原生投影汇总</span>;
}

function NativeBlueprintDetail({ frame }: { frame: NativeBlueprintWorkspaceFrame }) {
  const detail = frame.detail;
  if (!detail) return null;
  const statusCopy = detail.status === "supported"
    ? "当前内容目录已验证本只读明细的引用；这不表示可部署。"
    : detail.status === "truncated"
      ? "蓝图规模超过原生详情上限，仅显示安全摘要。"
      : "当前内容目录无法证明该内建 / MOD 蓝图语义，仅显示安全摘要。";

  return <section aria-label={`蓝图${detail.summary.name}原生只读详情`} data-native-blueprint-detail-status={detail.status}>
    <div className="blueprint-resource-note">
      <strong><ShieldCheck size={12} /> {detail.status === "supported" ? "只读明细引用已验证" : detail.status === "truncated" ? "详情已有界截断" : "目录语义未证明"}</strong>
      <span>{statusCopy}</span>
    </div>
    {detail.status === "supported" ? <>
      <div className="blueprint-external-ports">
        <strong>设备明细 · {detail.entities.length}</strong>
        <div>{detail.entities.slice(0, DETAIL_PREVIEW_ROWS).map((entity) => <span key={entity.key} data-native-blueprint-entity-key={entity.key}>{entity.buildingLabel} ×{entity.machineCount}{entity.recipeId ? ` · ${entity.recipeId}` : ""}</span>)}<DetailOverflow total={detail.entities.length} /></div>
      </div>
      <div className="blueprint-external-ports">
        <strong>输送线路 · {detail.belts.length}</strong>
        <div>{detail.belts.slice(0, DETAIL_PREVIEW_ROWS).map((belt) => <span key={belt.key} data-native-blueprint-belt-key={belt.key}><GitBranch size={11} />{belt.sourceKey} → {belt.targetKey} · {belt.itemId} ×{belt.lanes}</span>)}<DetailOverflow total={detail.belts.length} /></div>
      </div>
      <div className="blueprint-external-ports">
        <strong>资源锚点 · {detail.resourceAnchors.length}</strong>
        <div>{detail.resourceAnchors.slice(0, DETAIL_PREVIEW_ROWS).map((anchor) => <span key={anchor.key} data-native-blueprint-anchor-key={anchor.key}><MapPin size={11} />{anchor.resourceId} · {anchor.extractorBuildingId} ×{anchor.minerCount}</span>)}<DetailOverflow total={detail.resourceAnchors.length} /></div>
      </div>
      <div className="blueprint-external-ports">
        <strong>外部端口 · {detail.externalPorts.length}</strong>
        <div>{detail.externalPorts.slice(0, DETAIL_PREVIEW_ROWS).map((port) => <span key={port.key} data-native-blueprint-port-key={port.key}><Network size={11} />{port.direction === "input" ? "输入" : "输出"} · {port.itemId} · {port.entityKey}</span>)}<DetailOverflow total={detail.externalPorts.length} /></div>
      </div>
    </> : null}
  </section>;
}

/**
 * Player-authority blueprint surface. It accepts only the same-revision native
 * read projection. Its mutations are minimal rename and target-state transform
 * intents plus one stable-ID queue cancellation marker; renderer never
 * receives or constructs a blueprint body, refund ledger, or queue edit.
 */
function sameRenameIdentity(
  left: NativeBlueprintRenameIdentity,
  right: NativeBlueprintRenameIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint &&
    left.blueprintId === right.blueprintId && left.currentName === right.currentName &&
    left.currentRevision === right.currentRevision;
}

export function NativeBlueprintWorkspace({
  open,
  status,
  frame,
  latestIdentity,
  onClose,
  onSelectBlueprint,
  onLibraryCursorChange,
  onQueueCursorChange,
  onSubmitRenameIntent,
  onSubmitTransformIntent,
  onSubmitDeleteIntent,
  onSubmitQueueCancelIntent,
  pendingIdentity,
  transformPending,
  deletePending,
  queueCancelPending,
  resolution,
  onConsumeRenameResolution,
  commandPending,
}: NativeBlueprintWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<"library" | "queue">("library");
  const [renameEditor, setRenameEditor] = useState<{
    identity: NativeBlueprintRenameIdentity;
    draft: string;
    composing: boolean;
    acceptedSubmissionId: number | null;
    acceptedCommandRevision: number | null;
    feedback: "rejected" | "definite-failure" | null;
    conflict: "lineage" | "row" | null;
  } | null>(null);
  const renameCompositionRef = useRef(false);
  const renameSubmittedRef = useRef(false);
  const readyFrame = nativeFrameIsComplete(frame, status) ? frame : null;
  const readStatus = readyFrame
    ? "ready"
    : status === "loading" || status === "empty" ? status : "unavailable";
  const syncing = readStatus === "loading" || readStatus === "empty";
  const observedEditorTargetState = renameEditor
    ? nativeBlueprintRenameEditorTargetState(renameEditor.identity, latestIdentity, readyFrame)
    : null;

  useEffect(() => {
    if (open) return;
    renameCompositionRef.current = false;
    setRenameEditor((current) => current?.composing
      ? { ...current, composing: false }
      : current);
  }, [open]);

  useEffect(() => {
    if (!renameEditor || !resolution ||
        renameEditor.acceptedSubmissionId !== resolution.submissionId ||
        !sameRenameIdentity(renameEditor.identity, resolution)) return;
    renameCompositionRef.current = false;
    renameSubmittedRef.current = false;
    if (resolution.status === "confirmed") {
      setRenameEditor(null);
    } else {
      setRenameEditor((current) => current &&
        current.acceptedSubmissionId === resolution.submissionId
        ? {
          ...current,
          composing: false,
          acceptedSubmissionId: null,
          acceptedCommandRevision: null,
          feedback: "definite-failure",
        }
        : current);
    }
    onConsumeRenameResolution(resolution.submissionId);
  }, [onConsumeRenameResolution, renameEditor, resolution]);

  useEffect(() => {
    const conflict = observedEditorTargetState === "lineage-conflict"
      ? "lineage" as const
      : observedEditorTargetState === "row-conflict" ? "row" as const : null;
    if (!conflict) return;
    setRenameEditor((current) => current && current.conflict === null
      ? { ...current, conflict }
      : current);
  }, [observedEditorTargetState]);

  if (!open) return null;
  const interactionLocked = commandPending || pendingIdentity !== null ||
    transformPending !== null || deletePending !== null || queueCancelPending !== null ||
    renameEditor !== null;
  const editorTargetState = renameEditor?.conflict === "lineage"
    ? "lineage-conflict"
    : renameEditor?.conflict === "row" ? "row-conflict" : observedEditorTargetState;
  const editorAccepted = Boolean(renameEditor && renameEditor.acceptedSubmissionId !== null);
  const editorConflict = editorTargetState === "lineage-conflict" || editorTargetState === "row-conflict";
  const editorLocked = Boolean(
    editorAccepted || pendingIdentity || transformPending || deletePending ||
    queueCancelPending || editorConflict,
  );
  const canonicalDraft = renameEditor ? canonicalizeNativeBlueprintName(renameEditor.draft) : null;
  const editorCanSubmit = Boolean(renameEditor && editorTargetState === "ready" &&
    !editorLocked && !commandPending &&
    canonicalDraft !== null && canonicalDraft !== renameEditor.identity.currentName);
  const transformPendingCopy = transformPending
    ? transformPending.phase === "dispatching"
      ? "蓝图方向正在等待 main-owned durable ACK"
      : transformPending.phase === "reconciling"
        ? "蓝图方向结果不确定；仅进行六次有界只读对账，绝不自动重发"
        : transformPending.phase === "awaiting-projection"
          ? `蓝图方向已耐久提交；等待同 lineage revision ${transformPending.receipt?.revision} 投影确认`
          : "蓝图方向回执或投影无法证明；当前 lineage 保持锁定"
    : null;
  const deletePendingCopy = deletePending
    ? deletePending.phase === "dispatching"
      ? "蓝图删除正在等待 main-owned durable ACK"
      : deletePending.phase === "reconciling"
        ? "蓝图删除结果不确定；仅进行六次有界只读对账，绝不自动重发"
        : deletePending.phase === "awaiting-projection"
          ? `蓝图删除已耐久提交；等待同 lineage revision ${deletePending.receipt?.revision} 缺席投影`
          : "蓝图删除回执或投影无法证明；当前 lineage 保持锁定"
    : null;
  const queueCancelPendingCopy = queueCancelPending
    ? queueCancelPending.phase === "dispatching"
      ? "施工取消正在等待 main-owned durable ACK"
      : queueCancelPending.phase === "reconciling"
        ? "施工取消结果不确定；仅进行六次有界只读对账，绝不自动重发"
        : queueCancelPending.phase === "awaiting-projection"
          ? `施工取消已耐久提交；等待同 lineage revision ${queueCancelPending.receipt?.revision} 缺席投影`
          : "施工取消回执或投影无法证明；当前 lineage 保持锁定"
    : null;
  const pendingCopy = pendingIdentity
    ? pendingIdentity.phase === "awaiting-ack"
      ? "重命名正在等待 main-owned durable ACK"
      : pendingIdentity.phase === "awaiting-projection"
        ? `重命名已耐久提交；等待同 lineage revision ${pendingIdentity.expectedRevision} 投影确认`
        : pendingIdentity.phase === "uncertain"
          ? "重命名结果无法确认；保持锁定并仅等待权威对账，绝不自动重发"
          : "重命名身份或投影发生冲突；保持锁定并停止猜测"
    : transformPendingCopy ?? deletePendingCopy ?? queueCancelPendingCopy ?? (commandPending
      ? "另一条原生命令正在等待 durable ACK"
      : "页面按存储顺序显示；名称、方向与删除由 Rust 权威提交。");
  const editorCopy = renameEditor
    ? pendingIdentity?.phase === "uncertain"
      ? "提交结果不确定：草稿已保留，禁止自动重发"
      : pendingIdentity?.phase === "conflict"
        ? "权威对账冲突：草稿已保留，写入口已关闭"
        : editorTargetState === "lineage-conflict"
          ? "session / run / registry 已变化：草稿已保留，写入口已关闭"
          : editorTargetState === "row-conflict"
            ? "目标蓝图名称或行 revision 已变化：草稿已保留，写入口已关闭"
            : editorAccepted
              ? pendingIdentity?.phase === "awaiting-projection"
                ? `durable ACK 已确认；等待 revision ${pendingIdentity.expectedRevision} 精确投影`
                : "命令已接受；等待 durable ACK"
              : renameEditor.feedback === "definite-failure"
                ? "提交在 durable ACK 前明确失败；草稿已恢复，可修改后再提交"
                : renameEditor.feedback === "rejected"
                  ? "写入口未接受本次提交；草稿已保留"
                  : editorTargetState === "syncing"
                    ? "正在绑定最新权威 revision；可继续编辑，暂不可提交"
                    : `已绑定最新权威 revision ${readyFrame?.revision}`
    : null;

  return <WorkspaceFrame
    open={open}
    className="blueprint-workspace native-blueprint-workspace"
    ariaLabel="原生蓝图与待建施工"
    onRequestClose={onClose}
    data-native-blueprint-read-status={readStatus}
    data-native-blueprint-revision={readyFrame?.revision}
  >
    <header className="blueprint-header">
      <div className="blueprint-title"><i><Layers3 size={20} /></i><div><span>{readyFrame ? `Rust 玩家权威 · revision ${readyFrame.revision} · 有界投影` : "Rust 玩家权威 · 只读投影"}</span><strong>{activeTab === "library" ? "蓝图库" : "待建施工"}</strong></div></div>
      <div className="blueprint-headline">{readyFrame
        ? <><span>模板 <strong>{readyFrame.libraryPage.totalCount}</strong></span><span>队列 <strong>{readyFrame.queuePage.totalCount}</strong></span><span><ShieldCheck size={12} /> 同版本投影</span></>
        : <span>权威数据 <strong>{syncing ? "同步中" : "暂不可用"}</strong></span>}</div>
      <button className="blueprint-close" type="button" onClick={onClose} title="关闭原生蓝图工作区" aria-label="关闭原生蓝图工作区" data-native-blueprint-action="close"><X size={18} /></button>
    </header>
    <nav className="blueprint-tabs" aria-label={readyFrame ? "原生蓝图视图" : "原生蓝图读取状态"}>
      {readyFrame ? <>
        <button disabled={interactionLocked} className={activeTab === "library" ? "active" : ""} type="button" aria-current={activeTab === "library" ? "page" : undefined} onClick={() => setActiveTab("library")} data-native-blueprint-action="tab-library"><Layers3 size={14} />蓝图库</button>
        <button disabled={interactionLocked} className={activeTab === "queue" ? "active" : ""} type="button" aria-current={activeTab === "queue" ? "page" : undefined} onClick={() => setActiveTab("queue")} data-native-blueprint-action="tab-queue"><ListChecks size={14} />待建施工{readyFrame.queuePage.totalCount > 0 ? <em>{readyFrame.queuePage.totalCount}</em> : null}</button>
        <span role="status">{pendingCopy}</span>
      </> : <span role="status">{syncing ? "正在完成同 revision 的蓝图库、详情与施工队列分页" : "原生权威蓝图投影暂不可用"}</span>}
    </nav>

    {renameEditor ? <form
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 6, padding: 8 }}
      data-native-blueprint-rename-form={renameEditor.identity.blueprintId}
      data-native-blueprint-rename-state={pendingIdentity?.phase ?? editorTargetState}
      onSubmit={(event) => {
        event.preventDefault();
        if (!editorCanSubmit || renameCompositionRef.current || renameSubmittedRef.current ||
            canonicalDraft === null) return;
        renameSubmittedRef.current = true;
        let outcome: NativeBlueprintRenameSubmitOutcome;
        try {
          outcome = onSubmitRenameIntent(renameEditor.identity, canonicalDraft);
        } catch {
          outcome = Object.freeze({ status: "rejected" as const, reason: "gate" as const });
        }
        if (outcome.status === "accepted") {
          setRenameEditor((current) => current && sameRenameIdentity(current.identity, renameEditor.identity)
            ? {
              ...current,
              acceptedSubmissionId: outcome.submissionId,
              acceptedCommandRevision: outcome.commandRevision,
              feedback: null,
            }
            : current);
        } else {
          renameSubmittedRef.current = false;
          setRenameEditor((current) => current && sameRenameIdentity(current.identity, renameEditor.identity)
            ? { ...current, feedback: "rejected" }
            : current);
        }
      }}
    >
      <input
        value={renameEditor.draft}
        disabled={editorLocked}
        maxLength={64}
        aria-label={`重命名蓝图${renameEditor.identity.currentName}`}
        data-native-blueprint-rename-input={renameEditor.identity.blueprintId}
        data-native-blueprint-command-revision={renameEditor.acceptedCommandRevision ?? undefined}
        onChange={(event) => {
          const draft = event.currentTarget.value;
          setRenameEditor((current) => current ? { ...current, draft, feedback: null } : current);
        }}
        onCompositionStart={() => {
          renameCompositionRef.current = true;
          setRenameEditor((current) => current ? { ...current, composing: true } : current);
        }}
        onCompositionEnd={() => {
          renameCompositionRef.current = false;
          setRenameEditor((current) => current ? { ...current, composing: false } : current);
        }}
      />
      <button
        type="button"
        disabled={Boolean(editorAccepted || pendingIdentity)}
        onClick={() => {
          renameCompositionRef.current = false;
          renameSubmittedRef.current = false;
          setRenameEditor(null);
        }}
        data-native-blueprint-action="cancel-rename"
      >取消</button>
      <button
        type="submit"
        disabled={!editorCanSubmit || renameEditor.composing}
        data-native-blueprint-action="submit-rename"
      >提交名称</button>
      <span role={editorConflict || pendingIdentity?.phase === "conflict" ? "alert" : "status"} style={{ gridColumn: "1 / -1" }}>{editorCopy}</span>
    </form> : null}

    {readyFrame ? activeTab === "library" ? <div className="blueprint-library" data-native-blueprint-section="library">
      <NativeBlueprintPagination
        section="library"
        cursor={readyFrame.libraryPage.cursor}
        totalCount={readyFrame.libraryPage.totalCount}
        nextCursor={readyFrame.libraryPage.nextCursor}
        rowCount={readyFrame.library.length}
        locked={interactionLocked}
        onCursorChange={onLibraryCursorChange}
      />
      {readyFrame.library.length === 0 ? <div className="blueprint-empty"><BoxSelect size={28} /><strong>原生蓝图库为空</strong><span>当前 revision 没有已存储的蓝图记录。</span></div> : readyFrame.library.map((summary) => {
        const selected = readyFrame.selectedBlueprintId === summary.id;
        return <article className="blueprint-card" key={summary.id} data-native-blueprint-library-id={summary.id}>
          <header>
            <i><Layers3 size={18} /></i>
            <div style={{ display: "grid", minWidth: 0, gap: 3 }}><small style={{ color: "var(--muted)", fontSize: 8 }}>只读模板</small><strong style={{ overflowWrap: "anywhere" }}>{summary.name}</strong><small style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{summary.id}</small></div>
            <em>r{summary.revision} · {transformLabel(summary.rotation, summary.mirror)}</em>
          </header>
          <div className="blueprint-composition">
            <span>设备 {summary.counts.entities}</span><span>线路 {summary.counts.belts}</span><span>资源锚点 {summary.counts.resourceAnchors}</span><span>外部端口 {summary.counts.externalPorts}</span>
            {summary.detailStatus === "truncated" ? <span className="blueprint-composition-more">详情超限</span> : null}
          </div>
          {selected ? <NativeBlueprintDetail frame={readyFrame} /> : null}
          <footer>
            <button
              type="button"
              style={{ gridColumn: "1 / -1" }}
              aria-pressed={selected}
              disabled={interactionLocked}
              onClick={() => onSelectBlueprint(summary.id)}
              data-native-blueprint-action="select"
              data-native-blueprint-select={summary.id}
            ><ShieldCheck size={14} />{selected ? "当前只读详情" : "查看只读详情"}</button>
            {selected ? <button
              type="button"
              disabled={interactionLocked}
              onClick={() => {
                renameCompositionRef.current = false;
                renameSubmittedRef.current = false;
                setRenameEditor({
                  identity: {
                    sessionId: readyFrame.sessionId,
                    runId: readyFrame.runId,
                    registryFingerprint: readyFrame.registryFingerprint,
                    blueprintId: summary.id,
                    currentName: summary.name,
                    currentRevision: summary.revision,
                  },
                  draft: summary.name,
                  composing: false,
                  acceptedSubmissionId: null,
                  acceptedCommandRevision: null,
                  feedback: null,
                  conflict: null,
                });
              }}
              data-native-blueprint-action="begin-rename"
            ><PencilLine size={14} />重命名</button> : null}
            {selected ? <button
              type="button"
              disabled={interactionLocked}
              onClick={() => onSubmitTransformIntent(Object.freeze({
                sessionId: readyFrame.sessionId,
                runId: readyFrame.runId,
                revision: readyFrame.revision,
                registryFingerprint: readyFrame.registryFingerprint,
                blueprintId: summary.id,
                currentRowRevision: summary.revision,
                currentRotation: summary.rotation as NativeBlueprintRotation,
                currentMirror: summary.mirror as NativeBlueprintMirror,
              }), ((summary.rotation + 90) % 360) as NativeBlueprintRotation, summary.mirror as NativeBlueprintMirror)}
              data-native-blueprint-action="rotate-transform"
            ><RotateCw size={14} />顺时针 90°</button> : null}
            {selected ? <button
              type="button"
              disabled={interactionLocked}
              onClick={() => onSubmitTransformIntent(Object.freeze({
                sessionId: readyFrame.sessionId,
                runId: readyFrame.runId,
                revision: readyFrame.revision,
                registryFingerprint: readyFrame.registryFingerprint,
                blueprintId: summary.id,
                currentRowRevision: summary.revision,
                currentRotation: summary.rotation as NativeBlueprintRotation,
                currentMirror: summary.mirror as NativeBlueprintMirror,
              }), summary.rotation as NativeBlueprintRotation,
              summary.mirror === "horizontal" ? "none" : "horizontal")}
              data-native-blueprint-action="mirror-transform"
            ><FlipHorizontal size={14} />{summary.mirror === "horizontal" ? "取消水平镜像" : "水平镜像"}</button> : null}
            {selected ? <button
              className="danger"
              type="button"
              disabled={interactionLocked}
              onClick={() => onSubmitDeleteIntent(Object.freeze({
                sessionId: readyFrame.sessionId,
                runId: readyFrame.runId,
                revision: readyFrame.revision,
                registryFingerprint: readyFrame.registryFingerprint,
                blueprintId: summary.id,
                currentRowRevision: summary.revision,
                libraryTotalCount: readyFrame.libraryPage.totalCount,
              }))}
              title={`删除${summary.name}；已排队施工继续使用不可变版本`}
              aria-label={`删除${summary.name}`}
              data-native-blueprint-action="delete-blueprint"
            ><Trash2 size={14} />删除</button> : null}
          </footer>
        </article>;
      })}
    </div> : <section className="pending-construction-workspace" aria-label="原生待建施工" data-native-blueprint-section="queue">
      <header><div><ListChecks size={17} /><span><strong>施工队列 · Rust 权威取消</strong><small>明细只读；取消与完整退款由当前权威状态原子计算</small></span></div></header>
      <NativeBlueprintPagination
        section="queue"
        cursor={readyFrame.queuePage.cursor}
        totalCount={readyFrame.queuePage.totalCount}
        nextCursor={readyFrame.queuePage.nextCursor}
        rowCount={readyFrame.queue.length}
        locked={interactionLocked}
        onCursorChange={onQueueCursorChange}
      />
      {readyFrame.queue.length === 0 ? <div className="blueprint-empty"><ListChecks size={28} /><strong>没有待建施工记录</strong><span>当前 revision 的原生队列为空。</span></div> : <div className="pending-construction-list">
        {readyFrame.queue.map((entry) => <article
          className={`pending-construction-order pending-construction-order--${entry.semanticStatus === "catalog-backed" ? entry.status : "invalid"}`}
          key={entry.id}
          data-native-blueprint-queue-id={entry.id}
        >
          <header><div><i><Layers3 size={16} /></i><span><strong>{entry.blueprintName}</strong><small>{entry.planetName ?? entry.planetId} · {entry.planetId} · 坐标 {Math.round(entry.position.x)}, {Math.round(entry.position.y)}</small></span></div><em>{entry.semanticStatus === "catalog-backed" ? entry.status === "waiting-fleet" ? "建筑完成 · 等待载具" : "等待材料" : entry.semanticStatus === "truncated" ? "详情超限" : "语义未证明"}</em></header>
          <dl className="pending-construction-meta">
            <div><dt>排队时间</dt><dd>运行 {formatSimulationTime(entry.queuedAt)}</dd></div>
            <div><dt>方向</dt><dd>{transformLabel(entry.rotation, entry.mirror)}</dd></div>
            <div><dt>版本</dt><dd>r{entry.blueprintRevision}{entry.blueprintVersionId ? ` · ${entry.blueprintVersionId}` : ""}</dd></div>
          </dl>
          <div className="blueprint-composition">
            {entry.counts ? <><span>设备 {entry.counts.entities}</span><span>线路 {entry.counts.belts}</span><span>资源锚点 {entry.counts.resourceAnchors}</span><span>外部端口 {entry.counts.externalPorts}</span></> : <span className="blueprint-composition-more">明细数量不可用</span>}
            {entry.semanticStatus === "catalog-backed" ? <span>只读明细引用已验证 · 不代表可部署</span> : null}
            <span>已放置 {entry.placedEntityCount}</span><span>保留施工 {entry.reservedConstructionTotal.toLocaleString("zh-CN")}</span><span>保留载具 {entry.reservedFleetTotal.toLocaleString("zh-CN")}</span>
          </div>
          <footer>
            <button
              className="danger"
              type="button"
              disabled={interactionLocked}
              onClick={() => onSubmitQueueCancelIntent(Object.freeze({
                  sessionId: readyFrame.sessionId,
                  runId: readyFrame.runId,
                  revision: readyFrame.revision,
                  registryFingerprint: readyFrame.registryFingerprint,
                  queueEntryId: entry.id,
                  queueTotalCount: readyFrame.queuePage.totalCount,
                }))}
              title={`取消${entry.blueprintName}并完整返还尚未使用的建筑、线路和载具`}
              aria-label={`取消并返还${entry.blueprintName}`}
              data-native-blueprint-action="cancel-queue"
              data-native-blueprint-queue-cancel={entry.id}
            ><Trash2 size={14} />取消并返还</button>
          </footer>
        </article>)}
      </div>}
    </section> : <div className="blueprint-library">
      <div className="blueprint-empty" role={syncing ? "status" : "alert"}>
        {syncing ? <Layers3 size={28} /> : <LockKeyhole size={28} />}
        <strong>{syncing ? "正在同步原生权威蓝图投影" : "原生权威蓝图投影暂不可用"}</strong>
        <span>{syncing ? "只有完整且身份一致的分页会进入界面；进行中的名称草稿不会被卸载。" : "当前不会读取或显示 JavaScript 中的旧蓝图数据。"}</span>
      </div>
    </div>}
  </WorkspaceFrame>;
}
