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
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { NATIVE_BLUEPRINT_PAGE_ROWS } from "../game/nativeBlueprintWorkspaceStore";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceSnapshot,
} from "../game/nativeBlueprintWorkspaceStore";
import { WorkspaceFrame } from "./WorkspaceFrame";

export type NativeBlueprintWorkspaceReadStatus = NativeBlueprintWorkspaceSnapshot["status"];

export interface NativeBlueprintWorkspaceProps {
  open: boolean;
  status: NativeBlueprintWorkspaceReadStatus;
  frame: NativeBlueprintWorkspaceFrame | null;
  onClose: () => void;
  onSelectBlueprint: (blueprintId: string) => void;
  onLibraryCursorChange: (cursor: number) => void;
  onQueueCursorChange: (cursor: number) => void;
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
  onCursorChange,
}: {
  section: "library" | "queue";
  cursor: number;
  totalCount: number;
  nextCursor: number | null;
  rowCount: number;
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
      disabled={cursor === 0}
      onClick={() => onCursorChange(Math.max(0, cursor - NATIVE_BLUEPRINT_PAGE_ROWS))}
      aria-label={`${label}上一页`}
      data-native-blueprint-action={`page-${section}-prev`}
    ><ChevronLeft size={14} />上一页</button>
    <span data-native-blueprint-page-range={section}>第 {first}–{last} 项 / 共 {totalCount} 项</span>
    <button
      type="button"
      disabled={nextCursor === null}
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

function NativeBlueprintUnavailable({
  open,
  status,
  onClose,
}: {
  open: boolean;
  status: Exclude<NativeBlueprintWorkspaceReadStatus, "ready">;
  onClose: () => void;
}) {
  const loading = status === "loading";
  return <WorkspaceFrame
    open={open}
    className="blueprint-workspace native-blueprint-workspace"
    ariaLabel="原生蓝图与待建施工"
    onRequestClose={onClose}
    data-native-blueprint-read-status={status}
  >
    <header className="blueprint-header">
      <div className="blueprint-title"><i><Layers3 size={20} /></i><div><span>Rust 玩家权威 · 只读投影</span><strong>蓝图库</strong></div></div>
      <div className="blueprint-headline"><span>权威数据 <strong>{loading ? "同步中" : "暂不可用"}</strong></span></div>
      <button className="blueprint-close" type="button" onClick={onClose} title="关闭原生蓝图工作区" aria-label="关闭原生蓝图工作区" data-native-blueprint-action="close"><X size={18} /></button>
    </header>
    <nav className="blueprint-tabs" aria-label="原生蓝图读取状态">
      <span role="status">{loading ? "正在完成同 revision 的蓝图库、详情与施工队列分页" : "原生权威蓝图投影暂不可用"}</span>
    </nav>
    <div className="blueprint-library">
      <div className="blueprint-empty" role={loading ? "status" : "alert"}>
        {loading ? <Layers3 size={28} /> : <LockKeyhole size={28} />}
        <strong>{loading ? "正在同步原生权威蓝图投影" : "原生权威蓝图投影暂不可用"}</strong>
        <span>{loading ? "只有完整且身份一致的分页会进入界面。" : "当前不会读取或显示 JavaScript 中的旧蓝图数据。"}</span>
      </div>
    </div>
  </WorkspaceFrame>;
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
 * read projection and deliberately exposes no state-changing command surface.
 */
export function NativeBlueprintWorkspace({
  open,
  status,
  frame,
  onClose,
  onSelectBlueprint,
  onLibraryCursorChange,
  onQueueCursorChange,
}: NativeBlueprintWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<"library" | "queue">("library");
  if (!open) return null;
  if (!nativeFrameIsComplete(frame, status)) {
    const unavailableStatus = status === "loading" || status === "empty" ? status : "unavailable";
    return <NativeBlueprintUnavailable open status={unavailableStatus} onClose={onClose} />;
  }

  return <WorkspaceFrame
    className="blueprint-workspace native-blueprint-workspace"
    ariaLabel="原生蓝图与待建施工"
    onRequestClose={onClose}
    data-native-blueprint-read-status="ready"
    data-native-blueprint-revision={frame.revision}
  >
    <header className="blueprint-header">
      <div className="blueprint-title"><i><Layers3 size={20} /></i><div><span>Rust 玩家权威 · revision {frame.revision} · 只读</span><strong>{activeTab === "library" ? "蓝图库" : "待建施工"}</strong></div></div>
      <div className="blueprint-headline"><span>模板 <strong>{frame.libraryPage.totalCount}</strong></span><span>队列 <strong>{frame.queuePage.totalCount}</strong></span><span><ShieldCheck size={12} /> 同版本投影</span></div>
      <button className="blueprint-close" type="button" onClick={onClose} title="关闭原生蓝图工作区" aria-label="关闭原生蓝图工作区" data-native-blueprint-action="close"><X size={18} /></button>
    </header>
    <nav className="blueprint-tabs" aria-label="原生蓝图视图">
      <button className={activeTab === "library" ? "active" : ""} type="button" aria-current={activeTab === "library" ? "page" : undefined} onClick={() => setActiveTab("library")} data-native-blueprint-action="tab-library"><Layers3 size={14} />蓝图库</button>
      <button className={activeTab === "queue" ? "active" : ""} type="button" aria-current={activeTab === "queue" ? "page" : undefined} onClick={() => setActiveTab("queue")} data-native-blueprint-action="tab-queue"><ListChecks size={14} />待建施工{frame.queuePage.totalCount > 0 ? <em>{frame.queuePage.totalCount}</em> : null}</button>
      <span role="status">页面按存储顺序显示；当前仅提供查看。</span>
    </nav>

    {activeTab === "library" ? <div className="blueprint-library" data-native-blueprint-section="library">
      <NativeBlueprintPagination
        section="library"
        cursor={frame.libraryPage.cursor}
        totalCount={frame.libraryPage.totalCount}
        nextCursor={frame.libraryPage.nextCursor}
        rowCount={frame.library.length}
        onCursorChange={onLibraryCursorChange}
      />
      {frame.library.length === 0 ? <div className="blueprint-empty"><BoxSelect size={28} /><strong>原生蓝图库为空</strong><span>当前 revision 没有已存储的蓝图记录。</span></div> : frame.library.map((summary) => {
        const selected = frame.selectedBlueprintId === summary.id;
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
          {selected ? <NativeBlueprintDetail frame={frame} /> : null}
          <footer>
            <button
              type="button"
              style={{ gridColumn: "1 / -1" }}
              aria-pressed={selected}
              onClick={() => onSelectBlueprint(summary.id)}
              data-native-blueprint-action="select"
              data-native-blueprint-select={summary.id}
            ><ShieldCheck size={14} />{selected ? "当前只读详情" : "查看只读详情"}</button>
          </footer>
        </article>;
      })}
    </div> : <section className="pending-construction-workspace" aria-label="原生待建施工" data-native-blueprint-section="queue">
      <header><div><ListChecks size={17} /><span><strong>施工队列 · 只读</strong><small>按持久化数组顺序显示，不在 renderer 重排</small></span></div></header>
      <NativeBlueprintPagination
        section="queue"
        cursor={frame.queuePage.cursor}
        totalCount={frame.queuePage.totalCount}
        nextCursor={frame.queuePage.nextCursor}
        rowCount={frame.queue.length}
        onCursorChange={onQueueCursorChange}
      />
      {frame.queue.length === 0 ? <div className="blueprint-empty"><ListChecks size={28} /><strong>没有待建施工记录</strong><span>当前 revision 的原生队列为空。</span></div> : <div className="pending-construction-list">
        {frame.queue.map((entry) => <article
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
        </article>)}
      </div>}
    </section>}
  </WorkspaceFrame>;
}
