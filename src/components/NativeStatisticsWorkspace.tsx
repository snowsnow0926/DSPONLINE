import { BarChart3, Bookmark, BookmarkPlus, Focus, LockKeyhole, MapPin, Search, ShieldCheck, Trash2, TrendingUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ITEMS } from "../game/content";
import type {
  NativeStatisticsWorkspaceFrame,
  NativeStatisticsWorkspaceIdentity,
} from "../game/nativeStatisticsWorkspaceStore";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import type { ItemId, ProductionHistorySample } from "../game/types";
import type { CanvasViewport } from "../game/types";
import type { NativeWorkspaceActionReadModel } from "../game/factoryReadModels";
import { StableTextInput, clearStableTextDraft } from "./StableTextInput";
import { QuantityValue } from "./QuantityValue";
import { WorkspaceFrame } from "./WorkspaceFrame";

export type NativeStatisticsWorkspaceReadStatus = "empty" | "loading" | "ready" | "unavailable";

export interface NativeStatisticsWorkspaceProps {
  open: boolean;
  frame: NativeStatisticsWorkspaceFrame | null;
  latestIdentity: NativeStatisticsWorkspaceIdentity | null;
  status: NativeStatisticsWorkspaceReadStatus;
  onClose: () => void;
  workspace?: NativeWorkspaceActionReadModel | null;
  currentViewport?: CanvasViewport;
  workspacePending?: boolean;
  onAddCanvasBookmark?: (name: string, viewport: CanvasViewport) => void;
  onRenameCanvasBookmark?: (bookmarkId: string, name: string) => void;
  onOpenCanvasBookmark?: (bookmarkId: string) => void;
  onRemoveCanvasBookmark?: (bookmarkId: string) => void;
}

interface NativeItemRow {
  itemId: string;
  productionPerMinute: number;
  consumptionPerMinute: number;
  inventory: number;
}

function finiteMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function itemLabel(itemId: string): string {
  return (ITEMS as Readonly<Record<string, { readonly name: string }>>)[itemId]?.name ?? itemId;
}

function rateLabel(value: number): string {
  return `${formatQuantityCompact(Math.abs(value))}/min`;
}

function trendPoints(values: readonly number[], maximum: number): string {
  if (values.length === 0 || maximum <= 0) return "";
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : index / (values.length - 1) * 100;
    const y = 42 - Math.max(0, value) / maximum * 36;
    return `${x},${y}`;
  }).join(" ");
}

/**
 * Native-owner statistics intentionally consume only the bounded Rust
 * history projection. It never receives the full mutable state and cannot start the legacy
 * full-state statistics Worker or expose commands derived from a stale copy.
 */
export function NativeStatisticsWorkspace({
  open,
  frame: candidateFrame,
  latestIdentity,
  status,
  onClose,
  workspace = null,
  currentViewport,
  workspacePending = false,
  onAddCanvasBookmark,
  onRenameCanvasBookmark,
  onOpenCanvasBookmark,
  onRemoveCanvasBookmark,
}: NativeStatisticsWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [bookmarkName, setBookmarkName] = useState("");
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
  const exactFrame = Boolean(frame && latestIdentity && status === "ready" &&
    frame.revision === latestIdentity.revision);
  const samples: readonly ProductionHistorySample[] = frame?.samples ?? [];
  const latest = samples.at(-1) ?? null;
  const rows = useMemo<NativeItemRow[]>(() => {
    if (!latest) return [];
    const ids = new Set<string>([
      ...Object.keys(latest.productionPerMinute),
      ...Object.keys(latest.consumptionPerMinute),
      ...Object.keys(latest.inventory),
    ]);
    return [...ids].map((itemId) => ({
      itemId,
      productionPerMinute: finiteMetric(latest.productionPerMinute[itemId as ItemId]),
      consumptionPerMinute: finiteMetric(latest.consumptionPerMinute[itemId as ItemId]),
      inventory: finiteMetric(latest.inventory[itemId as ItemId]),
    })).sort((left, right) => left.itemId.localeCompare(right.itemId));
  }, [latest]);
  const visibleRows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    if (!term) return rows;
    return rows.filter((row) => `${itemLabel(row.itemId)} ${row.itemId}`.toLocaleLowerCase("zh-CN").includes(term));
  }, [query, rows]);
  const activeItemId = selectedItemId && rows.some((row) => row.itemId === selectedItemId)
    ? selectedItemId
    : rows[0]?.itemId ?? null;
  useEffect(() => {
    if (selectedItemId !== null && !rows.some((row) => row.itemId === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [rows, selectedItemId]);
  const trend = useMemo(() => activeItemId ? samples.slice(-90).map((sample) => ({
    production: Math.max(0, finiteMetric(sample.productionPerMinute[activeItemId as ItemId])),
    consumption: Math.max(0, finiteMetric(sample.consumptionPerMinute[activeItemId as ItemId])),
  })) : [], [activeItemId, samples]);
  const trendMaximum = Math.max(1, ...trend.flatMap((point) => [point.production, point.consumption]));
  const totalProduction = rows.reduce((total, row) => total + Math.max(0, row.productionPerMinute), 0);
  const totalConsumption = rows.reduce((total, row) => total + Math.max(0, row.consumptionPerMinute), 0);

  if (!frame) {
    const loading = status === "empty" || status === "loading";
    return <WorkspaceFrame
      open={open}
      className="statistics-workspace native-statistics-workspace"
      ariaLabel="Windows 原生生产统计"
      onRequestClose={onClose}
      data-native-statistics="history-v1"
      data-native-statistics-status={loading ? "loading" : "unavailable"}
    >
      <header className="statistics-header">
        <div className="statistics-title">
          <i><BarChart3 size={20} /></i>
          <div><span>Rust 玩家权威 · 只读投影</span><strong>生产统计</strong></div>
        </div>
        <div className="statistics-headline"><span>权威数据 <strong>{loading ? "同步中" : "暂不可用"}</strong></span></div>
        <button className="statistics-close" type="button" onClick={onClose} title="关闭生产统计" aria-label="关闭生产统计"><X size={18} /></button>
      </header>
      <div className="statistics-content statistics-production">
        <div className="statistics-empty" role={loading ? "status" : "alert"}>
          <span>{loading ? "正在读取当前 revision 的 Rust 生产历史" : "当前 revision 的 Rust 生产历史不可用；不会回退到旧网页存档"}</span>
        </div>
      </div>
    </WorkspaceFrame>;
  }

  return <WorkspaceFrame
    open={open}
    className="statistics-workspace native-statistics-workspace"
    ariaLabel="Windows 原生生产统计"
    onRequestClose={onClose}
    data-native-statistics="history-v1"
    data-native-statistics-status={exactFrame ? "ready" : status === "unavailable" ? "unavailable" : "loading"}
    data-native-statistics-revision={frame.revision}
    data-native-statistics-display-stale={exactFrame ? undefined : "true"}
  >
    <header className="statistics-header">
      <div className="statistics-title">
        <i><BarChart3 size={20} /></i>
        <div><span>Rust 权威 · revision {frame.revision}</span><strong>生产统计</strong></div>
      </div>
      <div className="statistics-headline">
        <span>生产 <strong>+{rateLabel(totalProduction)}</strong></span>
        <span>消耗 <strong>-{rateLabel(totalConsumption)}</strong></span>
        <span><ShieldCheck size={14} />{exactFrame ? "同版本采样" : "已验证只读旧帧"}</span>
      </div>
      <button className="statistics-close" type="button" onClick={onClose} title="关闭生产统计" aria-label="关闭生产统计"><X size={18} /></button>
    </header>

    <nav className="statistics-tabs" aria-label="原生统计范围">
      <button type="button" className="active" aria-current="page"><TrendingUp size={15} />生产历史</button>
      <span role="status">管理、批量编辑和银河结算尚未原生命令化，因此不会读取旧网页存档。</span>
    </nav>

    <div className="statistics-content statistics-production">
      {!exactFrame && latestIdentity ? <div className="dyson-planner-lock" role="status">
        <LockKeyhole size={16} />
        <strong>{status === "unavailable"
          ? `Rust revision ${latestIdentity.revision} 暂不可用`
          : `正在读取 Rust revision ${latestIdentity.revision}`}</strong>
        <span>继续显示已验证的 revision {frame.revision}；本工作区没有游戏权威写面。</span>
      </div> : null}
      <div className="statistics-toolbar">
        <label className="statistics-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选物品或 MOD ID" aria-label="筛选原生统计物品" /></label>
        <small>{samples.length} 个有界采样 · 最新模拟时间 {latest ? latest.elapsedSeconds.toFixed(1) : "-"} 秒</small>
      </div>

      {workspace && currentViewport ? <section className="network-bookmarks native-network-bookmarks" aria-label="Windows 原生画布书签">
        <header><Bookmark size={15} /><span>画布书签</span><strong>{workspace.bookmarks.totalCount}/24</strong></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (workspacePending || !onAddCanvasBookmark) return;
          onAddCanvasBookmark(bookmarkName, currentViewport);
          setBookmarkName("");
          clearStableTextDraft("native-canvas-bookmark-name");
        }}>
          <StableTextInput
            draftId="native-canvas-bookmark-name"
            name="bookmarkName"
            value={bookmarkName}
            onValueChange={setBookmarkName}
            maxLength={28}
            placeholder="当前 Rust 画布视角"
            aria-label="原生画布书签名称"
          />
          <button type="submit" disabled={workspacePending || !onAddCanvasBookmark} title="保存当前画布视角" aria-label="保存当前画布视角"><BookmarkPlus size={14} /></button>
        </form>
        <div>{workspace.bookmarks.rows.length === 0 ? <p><MapPin size={18} /><span>尚未保存视角</span></p> : workspace.bookmarks.rows.map((bookmark) => <article key={bookmark.id}>
          <MapPin size={13} />
          <span>
            <StableTextInput
              commitOnBlur
              draftId={`native-canvas-bookmark-name:${bookmark.id}`}
              value={bookmark.name}
              onValueChange={(name) => onRenameCanvasBookmark?.(bookmark.id, name)}
              disabled={workspacePending}
              aria-label={`${bookmark.name}名称`}
              onBlur={() => clearStableTextDraft(`native-canvas-bookmark-name:${bookmark.id}`)}
            />
            <small>{bookmark.planetId} · {Math.round(bookmark.viewport.zoom * 100)}%</small>
          </span>
          <button type="button" onClick={() => onOpenCanvasBookmark?.(bookmark.id)} disabled={!onOpenCanvasBookmark} title={`打开${bookmark.name}`} aria-label={`打开${bookmark.name}`}><Focus size={13} /></button>
          <button className="danger" type="button" onClick={() => onRemoveCanvasBookmark?.(bookmark.id)} disabled={workspacePending || !onRemoveCanvasBookmark} title={`删除${bookmark.name}`} aria-label={`删除${bookmark.name}`}><Trash2 size={13} /></button>
        </article>)}</div>
      </section> : null}

      {activeItemId && trend.length > 0 ? <section className="production-history-trend" aria-label="原生生产历史趋势">
        <header><div><TrendingUp size={15} /><span>{itemLabel(activeItemId)}</span></div><small>最近 {trend.length} 个压缩采样点</small></header>
        <div className="production-history-chart">
          <span className="production-history-axis production-history-axis--top">{rateLabel(trendMaximum)}</span>
          <span className="production-history-axis production-history-axis--bottom">0</span>
          <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label={`${itemLabel(activeItemId)}生产和消耗趋势`}>
            <line x1="0" x2="100" y1="42" y2="42" />
            <line x1="0" x2="100" y1="24" y2="24" />
            <line x1="0" x2="100" y1="6" y2="6" />
            <polyline className="production-history-line production" points={trendPoints(trend.map((point) => point.production), trendMaximum)} />
            <polyline className="production-history-line consumption" points={trendPoints(trend.map((point) => point.consumption), trendMaximum)} />
          </svg>
        </div>
        <footer><span><i className="production" />生产</span><span><i className="consumption" />消耗</span><strong>{itemLabel(activeItemId)}</strong></footer>
      </section> : null}

      <div className={`statistics-table${visibleRows.length === 0 ? " statistics-table--empty" : ""}`}>
        <header><span>物品</span><span>生产 /min</span><span>消耗 /min</span><span>净增量 /min</span><span>库存</span><span>来源</span></header>
        <div>
          {visibleRows.length === 0 ? <div className="statistics-empty"><span>{latest ? "没有符合条件的物品" : "等待 Rust 生产历史采样"}</span></div> : visibleRows.map((row) => {
            const net = row.productionPerMinute - row.consumptionPerMinute;
            return <button
              className={`statistics-row${activeItemId === row.itemId ? " statistics-row--trend-selected" : ""}`}
              type="button"
              key={row.itemId}
              onClick={() => setSelectedItemId(row.itemId)}
              title={`查看 ${itemLabel(row.itemId)} 趋势`}
            >
              <span className="statistics-item"><strong>{itemLabel(row.itemId)}</strong><small>{row.itemId}</small></span>
              <span className="rate-positive" title={formatQuantityExact(row.productionPerMinute)}>+{rateLabel(row.productionPerMinute)}</span>
              <span className="rate-negative" title={formatQuantityExact(row.consumptionPerMinute)}>-{rateLabel(row.consumptionPerMinute)}</span>
              <span className={net > 0 ? "rate-positive" : net < 0 ? "rate-negative" : "rate-neutral"}>{net > 0 ? "+" : net < 0 ? "-" : ""}{rateLabel(net)}</span>
              <span><QuantityValue value={row.inventory} interactive={false} /></span>
              <span>Rust</span>
            </button>;
          })}
        </div>
      </div>
    </div>
  </WorkspaceFrame>;
}
