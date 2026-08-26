import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, Bookmark, BookmarkPlus, Box, Calculator, CheckSquare, CircleCheckBig, ClipboardCopy, Factory, Focus, Gauge, MapPin, Orbit, Pause, Play, Plus, Rocket, Route, Search, Send, Settings2, Sparkles, Trash2, TrendingUp, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ITEMS, PLANET_LIST, getBuilding, getItem, getPlanet, getRecipe, getStarSystem } from "../game/content";
import { calculateProductionPlan, getProductionRecipeOptions } from "../game/planning";
import { calculateFactoryStatisticsAsync, type FactoryStatistics, type ItemStatistics } from "../game/statistics";
import type { StatisticsWorkerRequest, StatisticsWorkerResponse } from "../game/statistics.worker";
import type { ContentPackRuntimeSnapshot } from "../game/contentPacks";
import { getGalacticIndustrySnapshot, getPowerGridMetrics, getResourceReserveSnapshot, POWER_GRID_IDS, POWER_GRID_LABELS } from "../game/engine";
import { GALACTIC_EXPORT_DEFINITIONS, INFINITE_RESEARCH_DEFINITIONS, getGalacticExportTarget, getInfiniteResearchCompletion, getInfiniteResearchLevel } from "../game/endgame";
import { getInfiniteResearchCostString, isInfiniteResearchComplete } from "../game/infiniteResearch";
import type { GalacticActivityPublicStatus } from "../game/galacticActivity";
import { getPlanetDisplayName, getPlanetIndustrialProfile } from "../game/galaxy";
import { listBeltNetworks, type BeltHealth } from "../game/network";
import type { BeltRouteMode, CanvasBookmark, GalacticDispatchThrottle, GalacticExportPriority, GalacticExportProjectId, GameState, InfiniteResearchId, ItemId, PlanetId, RecipeId, StationSlotTemplate } from "../game/types";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { ProductionManagement } from "./ProductionManagement";
import { GalacticActivityPanel } from "./GalacticActivityPanel";
import { QuantityValue } from "./QuantityValue";
import { PowerValue } from "./PowerValue";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import {
  calculateProductionWindowSnapshot,
  createProductionTrendSeries,
  formatProductionStatistic,
  formatProductionStatisticExact,
  PRODUCTION_STATISTICS_WINDOWS,
  type ProductionStatisticsWindow,
  type ProductionTrendPoint,
} from "../game/productionStatistics";
import { ExactValue } from "./ExactValue";
import { useAppLocale } from "../i18n/locale";
import { StableTextInput, clearStableTextDraft } from "./CompositionSafeInput";
import { WorkspaceFrame } from "./WorkspaceFrame";

export type StatisticsTab = "management" | "production" | "efficiency" | "networks" | "planning" | "power" | "issues" | "galaxy";
type ItemFilter = "all" | "producing" | "deficit" | "blocked";
type ItemSortKey = "catalog" | "production" | "consumption" | "net" | "inventory" | "name";
type ItemSortDirection = "asc" | "desc";

interface ItemSort {
  key: ItemSortKey;
  direction: ItemSortDirection;
}

interface StatisticsWorkspaceProps {
  open: boolean;
  game: GameState;
  onClose: () => void;
  onCreatePlan: (itemId: ItemId, targetPerMinute: number, planetId: PlanetId | "all") => void;
  onUpdatePlan: (planId: string, changes: { name?: string; itemId?: ItemId; targetPerMinute?: number; planetId?: PlanetId | "all" }) => void;
  onSetPlanRecipe: (planId: string, itemId: ItemId, recipeId: RecipeId) => void;
  onRemovePlan: (planId: string) => void;
  onSelectInfiniteResearch: (researchId: InfiniteResearchId) => void;
  onInfiniteResearchAutomation: (enabled: boolean) => void;
  onGalacticDispatchAutomation: (enabled: boolean) => void;
  onGalacticDispatchThrottle: (throttle: GalacticDispatchThrottle) => void;
  onGalacticExporterPausedChange: (entityId: string, paused: boolean) => void;
  onGalacticExportEnabled: (projectId: GalacticExportProjectId, enabled: boolean) => void;
  onGalacticExportPriority: (projectId: GalacticExportProjectId, priority: GalacticExportPriority) => void;
  onDispatchGalacticExport: (projectId: GalacticExportProjectId) => void;
  onFocusEntity: (entityId: string, planetId: PlanetId) => void;
  onFocusBeltNetwork: (beltId: string, planetId: PlanetId) => void;
  onBulkRecipeChange: (entityIds: string[], recipeId: RecipeId) => void;
  onBulkStationSlotApply: (entityIds: string[], slotIndex: number, template: StationSlotTemplate) => void;
  onBulkBeltUpgrade: (beltIds: string[]) => void;
  onBulkBeltRoute: (beltIds: string[], routeMode: BeltRouteMode) => void;
  onBulkBeltConfiguration: (templateBeltId: string, targetNetworkIds: string[]) => {
    applied: number;
    skipped: number;
    failed: number;
    error?: string;
  };
  onBulkBeltRemove: (beltIds: string[]) => void;
  onBeltHeatmapChange: (enabled: boolean) => void;
  onAddCanvasBookmark: (name: string) => void;
  onRenameCanvasBookmark: (bookmarkId: string, name: string) => void;
  onOpenCanvasBookmark: (bookmark: CanvasBookmark) => void;
  onRemoveCanvasBookmark: (bookmarkId: string) => void;
  focusTab?: StatisticsTab | null;
  mobile?: boolean;
  galacticActivityStatus: GalacticActivityPublicStatus | null;
  contentPackRuntimeSnapshot: ContentPackRuntimeSnapshot;
}

function ItemMark({ itemId }: { itemId: ItemId }) {
  return <ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} className="item-mark" /></ItemHoverCard>;
}

function ProductionStatisticValue({ value, suffix, sign = "", showSuffix = false }: { value: number; suffix: string; sign?: string; showSuffix?: boolean }) {
  const normalizedSign = Math.abs(value) < 0.005 ? "" : sign;
  return <ExactValue
    compact={<>{normalizedSign}{formatProductionStatistic(Math.abs(value))}{showSuffix ? <small>{suffix}</small> : null}</>}
    label={`${normalizedSign}${formatProductionStatisticExact(Math.abs(value))}${suffix}`}
  />;
}

function reserveTime(seconds: number): string {
  if (seconds <= 0) return "-";
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
}

function efficiencyPoints(values: number[]): string {
  if (values.length === 0) return "";
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : index / (values.length - 1) * 100;
    return `${x},${42 - Math.max(0, Math.min(1, value)) * 38}`;
  }).join(" ");
}

function sortItems(items: ItemStatistics[], sort: ItemSort): ItemStatistics[] {
  const catalogOrder = new Map((Object.keys(ITEMS) as ItemId[]).map((itemId, index) => [itemId, index]));
  const catalogDifference = (a: ItemStatistics, b: ItemStatistics) =>
    (catalogOrder.get(a.itemId) ?? Number.MAX_SAFE_INTEGER) - (catalogOrder.get(b.itemId) ?? Number.MAX_SAFE_INTEGER) ||
    a.itemId.localeCompare(b.itemId);
  return [...items].sort((a, b) => {
    if (sort.key === "catalog") return catalogDifference(a, b);
    const direction = sort.direction === "asc" ? 1 : -1;
    let difference = 0;
    if (sort.key === "name") difference = getItem(a.itemId).name.localeCompare(getItem(b.itemId).name, "zh-CN");
    else if (sort.key === "inventory") difference = a.inventory - b.inventory;
    else if (sort.key === "consumption") difference = a.consumptionPerMinute - b.consumptionPerMinute;
    else if (sort.key === "net") difference = a.netPerMinute - b.netPerMinute;
    else difference = a.productionPerMinute - b.productionPerMinute;
    return difference === 0 ? catalogDifference(a, b) : difference * direction;
  });
}

const NETWORK_HEALTH_LABELS: Record<BeltHealth, string> = {
  healthy: "稳定",
  underused: "低负载",
  starved: "缺料",
  congested: "拥堵",
  idle: "等待",
};

const PRODUCTION_STATISTICS_WINDOW_LABELS_EN: Record<ProductionStatisticsWindow, string> = {
  second: "Per second",
  minute: "Past minute",
  "ten-minutes": "Past 10 minutes",
  hour: "Past hour",
  total: "Lifetime output",
};

function productionTrendPolyline(points: readonly ProductionTrendPoint[], field: "productionPerMinute" | "consumptionPerMinute", maximum: number): string {
  if (points.length === 0 || maximum <= 0) return "";
  return points.map((point, index) => {
    const x = points.length === 1 ? 50 : index / (points.length - 1) * 100;
    const y = 42 - Math.max(0, Math.min(1, point[field] / maximum)) * 36;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

const EMPTY_FACTORY_STATISTICS: FactoryStatistics = {
  items: [],
  issues: [],
  powerConsumers: [],
  totalProductionPerMinute: 0,
  totalConsumptionPerMinute: 0,
};

function NetworkOverview({ game, onFocusBeltNetwork, onBulkBeltUpgrade, onBulkBeltRoute, onBulkBeltConfiguration, onBulkBeltRemove, onBeltHeatmapChange, onAddCanvasBookmark, onRenameCanvasBookmark, onOpenCanvasBookmark, onRemoveCanvasBookmark }: Pick<StatisticsWorkspaceProps,
  "game" | "onFocusBeltNetwork" | "onBulkBeltUpgrade" | "onBulkBeltRoute" | "onBulkBeltConfiguration" | "onBulkBeltRemove" | "onBeltHeatmapChange" | "onAddCanvasBookmark" | "onRenameCanvasBookmark" | "onOpenCanvasBookmark" | "onRemoveCanvasBookmark">) {
  const [scope, setScope] = useState<"active" | "all">("active");
  const [health, setHealth] = useState<BeltHealth | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [syncPreviewOpen, setSyncPreviewOpen] = useState(false);
  const [syncReport, setSyncReport] = useState<{ applied: number; skipped: number; failed: number; error?: string } | null>(null);
  const [routeMode, setRouteMode] = useState<BeltRouteMode>("auto");
  const [bookmarkName, setBookmarkName] = useState("");
  const allNetworks = useMemo(() => listBeltNetworks(game, scope === "active" ? game.activePlanetId : undefined), [game, scope]);
  const networks = useMemo(() => allNetworks.filter((network) => {
    if (health !== "all" && network.health !== health) return false;
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return !term || `${getItem(network.itemId).name} ${getPlanetDisplayName(game, network.planetId)} ${network.label}`.toLocaleLowerCase("zh-CN").includes(term);
  }), [allNetworks, health, query]);
  const visibleIds = networks.map((network) => network.originBeltId);
  const selectedVisible = selectedIds.filter((id) => visibleIds.includes(id));
  const selectedCount = selectedVisible.length;
  const templateSelected = templateId !== null && selectedVisible.includes(templateId);
  const templateNetwork = templateSelected ? allNetworks.find((network) => network.originBeltId === templateId) : undefined;
  const templateBelt = templateId ? game.belts.find((belt) => belt.id === templateId) : undefined;
  const targetNetworkIds = selectedVisible.filter((id) => id !== templateId);
  const targetLineCount = new Set(targetNetworkIds.flatMap((id) => allNetworks.find((network) => network.originBeltId === id)?.beltIds ?? [])).size;
  const totalFlow = allNetworks.reduce((sum, network) => sum + network.totalFlow, 0);
  const totalCapacity = allNetworks.reduce((sum, network) => sum + network.totalCapacity, 0);
  const problemCount = allNetworks.filter((network) => network.health === "congested" || network.health === "starved").length;

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => allNetworks.some((network) => network.originBeltId === id)));
    setTemplateId((current) => current && allNetworks.some((network) => network.originBeltId === current) ? current : null);
  }, [allNetworks]);

  const toggleNetwork = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) {
        const next = current.filter((value) => value !== id);
        if (templateId === id) setTemplateId(next[0] ?? null);
        return next;
      }
      if (!templateId) setTemplateId(id);
      return [...current, id];
    });
    setSyncPreviewOpen(false);
    setSyncReport(null);
  };
  return (
    <div className="statistics-content network-overview">
      <section className="network-summary-band">
        <div><span>连续网络</span><strong>{allNetworks.length}</strong><small>{scope === "active" ? getPlanetDisplayName(game, game.activePlanetId) : "全星区"}</small></div>
        <div><span>实时吞吐</span><strong>{totalFlow.toFixed(1)}<small>/s</small></strong><small>容量 {totalCapacity.toFixed(0)}/s</small></div>
        <div className={problemCount > 0 ? "warning" : ""}><span>需处理</span><strong>{problemCount}</strong><small>拥堵或缺料</small></div>
        <label className="network-heatmap-toggle"><input type="checkbox" checked={game.settings.beltHeatmapEnabled} onChange={(event) => onBeltHeatmapChange(event.target.checked)} /><span>吞吐热力图</span><strong>{game.settings.beltHeatmapEnabled ? "显示中" : "关闭"}</strong></label>
      </section>
      <div className="network-toolbar">
        <label className="statistics-search"><Search size={14} /><StableTextInput draftId="network-overview-search" value={query} onValueChange={setQuery} placeholder="物品、行星或状态" aria-label="筛选运输网络" /></label>
        <div className="statistics-filter network-scope" aria-label="网络范围"><button type="button" className={scope === "active" ? "active" : ""} onClick={() => setScope("active")}>当前行星</button><button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全星区</button></div>
        <label className="statistics-sort"><span>状态</span><select value={health} onChange={(event) => setHealth(event.target.value as BeltHealth | "all")}><option value="all">全部</option>{Object.entries(NETWORK_HEALTH_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
      <section className={`network-batch-bar${selectedCount > 0 ? " network-batch-bar--active" : ""}`} aria-label="批量线路操作">
        <button type="button" className="network-select-all" onClick={() => {
          const clearing = selectedCount === visibleIds.length && visibleIds.length > 0;
          setSelectedIds(clearing ? [] : visibleIds);
          setTemplateId(null);
          setSyncPreviewOpen(false);
          setSyncReport(null);
        }}><CheckSquare size={14} />{selectedCount === visibleIds.length && visibleIds.length > 0 ? "取消全选" : "选择当前结果"}</button>
        <strong>{selectedCount} 个网络</strong>
        <button type="button" disabled={selectedCount === 0} onClick={() => onBulkBeltUpgrade(selectedVisible)}><ArrowUp size={14} />升级传送带</button>
        <label><select value={routeMode} onChange={(event) => setRouteMode(event.target.value as BeltRouteMode)} aria-label="批量线路路由"><option value="auto">自动避让</option><option value="bezier">曲线</option><option value="upper">上绕</option><option value="lower">下绕</option><option value="manual">手动控制点</option></select><button type="button" disabled={selectedCount === 0} onClick={() => onBulkBeltRoute(selectedVisible, routeMode)}><Route size={14} />批量改道</button></label>
        <button type="button" disabled={selectedCount < 2 || !templateSelected} onClick={() => { setSyncPreviewOpen(true); setSyncReport(null); }} title={templateSelected ? "预览模板设置并同步到其余网络" : "框选没有点击顺序，请先指定模板线路"}><ClipboardCopy size={14} />同步首条设置</button>
        <button className="danger" type="button" disabled={selectedCount === 0} onClick={() => { onBulkBeltRemove(selectedVisible); setSelectedIds([]); setTemplateId(null); setSyncPreviewOpen(false); setSyncReport(null); }}><Trash2 size={14} />批量回收</button>
      </section>
      {selectedCount > 1 && !templateSelected ? <p className="network-template-required">当前选择没有明确顺序，请在下方所选线路中指定一条模板。</p> : null}
      {syncPreviewOpen && templateNetwork && templateBelt ? <section className="network-sync-preview" aria-label="线路设置同步预览">
        <header><ClipboardCopy size={16} /><span><strong>模板：{getItem(templateNetwork.itemId).name} · {getPlanetDisplayName(game, templateNetwork.planetId)}</strong><small>将覆盖 {targetNetworkIds.length} 个网络、{targetLineCount} 条线路的配置</small></span></header>
        <dl><div><dt>并联</dt><dd>×{templateBelt.lanes}</dd></div><div><dt>货物堆叠</dt><dd>×{templateBelt.stackSize ?? 1}</dd></div><div><dt>优先级</dt><dd>{templateBelt.priority === 2 ? "高" : templateBelt.priority === 1 ? "标准" : "低"}</dd></div><div><dt>线路形态</dt><dd>{{ auto: "自动避让", bezier: "曲线", upper: "上绕", lower: "下绕", manual: "手动控制点" }[templateBelt.routeMode ?? "auto"]}</dd></div><div><dt>流量监测</dt><dd>{templateBelt.monitorEnabled ? "开启" : "关闭"}</dd></div></dl>
        <p>累计运输量、实时流量、线路进度和在途物资不会改变。</p>
        <footer><button type="button" onClick={() => setSyncPreviewOpen(false)}>取消</button><button className="primary" type="button" onClick={() => { const result = onBulkBeltConfiguration(templateId!, targetNetworkIds); setSyncReport(result); setSyncPreviewOpen(false); }}>确认同步</button></footer>
      </section> : null}
      {syncReport ? <p className={`network-sync-report${syncReport.failed > 0 ? " network-sync-report--failed" : ""}`} role="status">成功 {syncReport.applied} 条 · 跳过 {syncReport.skipped} 条 · 失败 {syncReport.failed} 条{syncReport.error ? ` · ${syncReport.error}` : ""}</p> : null}
      <div className="network-workspace-layout">
        <section className="network-ledger">
          <header><span>选择 / 物品</span><span>行星与拓扑</span><span>吞吐</span><span>诊断</span><span>定位</span></header>
          <div>{networks.length === 0 ? <div className="statistics-empty"><Route size={22} /><span>没有符合条件的运输网络</span></div> : networks.map((network) => {
            const bottleneck = network.diagnostics.find((diagnostic) => diagnostic.beltId === network.bottleneckBeltId);
            const selected = selectedIds.includes(network.originBeltId);
            const template = templateId === network.originBeltId;
            return <article className={`network-row network-row--${network.health}${selected ? " network-row--selected" : ""}${template ? " network-row--template" : ""}`} key={network.originBeltId}>
              <div className="network-row-selection"><label><input type="checkbox" checked={selected} onChange={() => toggleNetwork(network.originBeltId)} /><ItemMark itemId={network.itemId} /><span><strong>{getItem(network.itemId).name}</strong><small>{NETWORK_HEALTH_LABELS[network.health]}</small></span></label>{selected ? <button className={template ? "active" : ""} type="button" aria-pressed={template} onClick={() => { setTemplateId(network.originBeltId); setSyncPreviewOpen(false); setSyncReport(null); }} title="设为同步模板">{template ? "模板" : "设为模板"}</button> : null}</div>
              <span><strong>{getPlanetDisplayName(game, network.planetId)}</strong><small>{network.beltIds.length} 线路 · {network.entityIds.length} 节点 · {network.sourceEntityIds.length}→{network.sinkEntityIds.length}</small></span>
              <span className="network-throughput"><i><b style={{ width: `${network.utilization * 100}%` }} /></i><strong>{network.totalFlow.toFixed(1)} / {network.totalCapacity.toFixed(0)} s⁻¹</strong><small>{Math.round(network.utilization * 100)}% 利用率</small></span>
              <span><strong>{network.label}</strong><small>{bottleneck?.label ?? "无瓶颈"}{network.capacityDeficit > 0.01 ? ` · 缺口 ${network.capacityDeficit.toFixed(1)}/s` : ""}</small></span>
              <button type="button" onClick={() => onFocusBeltNetwork(network.originBeltId, network.planetId)} title={`定位${getItem(network.itemId).name}网络`} aria-label={`定位${getItem(network.itemId).name}网络`}><Focus size={15} /></button>
            </article>;
          })}</div>
        </section>
        <aside className="canvas-bookmarks">
          <header><Bookmark size={15} /><span>画布书签</span><strong>{game.canvasBookmarks.length}/24</strong></header>
          <form onSubmit={(event) => { event.preventDefault(); (event.currentTarget.elements.namedItem("bookmarkName") as HTMLInputElement | null)?.blur(); onAddCanvasBookmark(bookmarkName); setBookmarkName(""); clearStableTextDraft("canvas-bookmark-name"); }}><StableTextInput draftId="canvas-bookmark-name" name="bookmarkName" value={bookmarkName} onValueChange={setBookmarkName} maxLength={28} placeholder={`${getPlanetDisplayName(game, game.activePlanetId)}视角`} aria-label="画布书签名称" /><button type="submit" title="保存当前画布视角" aria-label="保存当前画布视角"><BookmarkPlus size={14} /></button></form>
          <div>{game.canvasBookmarks.length === 0 ? <p><MapPin size={18} /><span>尚未保存视角</span></p> : game.canvasBookmarks.map((bookmark) => <article key={bookmark.id}><MapPin size={13} /><span><StableTextInput commitOnBlur draftId={`canvas-bookmark-name:${bookmark.id}`} value={bookmark.name} onValueChange={(name) => onRenameCanvasBookmark(bookmark.id, name)} aria-label={`${bookmark.name}名称`} onBlur={() => clearStableTextDraft(`canvas-bookmark-name:${bookmark.id}`)} /><small>{getPlanetDisplayName(game, bookmark.planetId)} · {Math.round(bookmark.viewport.zoom * 100)}%</small></span><button type="button" onClick={() => onOpenCanvasBookmark(bookmark)} title={`打开${bookmark.name}`} aria-label={`打开${bookmark.name}`}><Focus size={13} /></button><button className="danger" type="button" onClick={() => onRemoveCanvasBookmark(bookmark.id)} title={`删除${bookmark.name}`} aria-label={`删除${bookmark.name}`}><Trash2 size={13} /></button></article>)}</div>
        </aside>
      </div>
    </div>
  );
}

export function StatisticsWorkspace({ open, game, onClose, onCreatePlan, onUpdatePlan, onSetPlanRecipe, onRemovePlan, onSelectInfiniteResearch, onInfiniteResearchAutomation, onGalacticDispatchAutomation, onGalacticDispatchThrottle, onGalacticExporterPausedChange, onGalacticExportEnabled, onGalacticExportPriority, onDispatchGalacticExport, onFocusEntity, onFocusBeltNetwork, onBulkRecipeChange, onBulkStationSlotApply, onBulkBeltUpgrade, onBulkBeltRoute, onBulkBeltConfiguration, onBulkBeltRemove, onBeltHeatmapChange, onAddCanvasBookmark, onRenameCanvasBookmark, onOpenCanvasBookmark, onRemoveCanvasBookmark, focusTab, mobile = false, galacticActivityStatus, contentPackRuntimeSnapshot }: StatisticsWorkspaceProps) {
  const { isEnglish } = useAppLocale();
  const [tab, setTab] = useState<StatisticsTab>("production");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [sort, setSort] = useState<ItemSort>({ key: "catalog", direction: "asc" });
  const [productionWindowId, setProductionWindowId] = useState<ProductionStatisticsWindow>("minute");
  const [trendItemId, setTrendItemId] = useState<ItemId | null>(null);
  const [query, setQuery] = useState("");
  const [planetScope, setPlanetScope] = useState<PlanetId | "all">("all");
  const [planItemId, setPlanItemId] = useState<ItemId>("electromagnetic_matrix");
  const [planTarget, setPlanTarget] = useState(60);
  const [planPlanetId, setPlanPlanetId] = useState<PlanetId | "all">("all");
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [expandedItemId, setExpandedItemId] = useState<ItemId | null>(null);
  const [statistics, setStatistics] = useState<FactoryStatistics>(EMPTY_FACTORY_STATISTICS);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);
  const [statisticsSample, setStatisticsSample] = useState<{ elapsedSeconds: number; durationMs: number } | null>(null);
  const statisticsGameRef = useRef(game);
  const statisticsRequestIdRef = useRef(0);
  statisticsGameRef.current = game;
  const statisticsRequired = open && (tab === "production" || tab === "power" || tab === "issues");
  useEffect(() => {
    if (!statisticsRequired) return;
    let disposed = false;
    let inFlight = false;
    let worker: Worker | null = null;
    let fallbackController: AbortController | null = null;
    setStatistics(EMPTY_FACTORY_STATISTICS);
    setStatisticsSample(null);
    setStatisticsError(null);
    setStatisticsLoading(true);

    const finish = (result: FactoryStatistics, elapsedSeconds: number, durationMs: number) => {
      if (disposed) return;
      setStatistics(result);
      setStatisticsSample({ elapsedSeconds, durationMs });
      setStatisticsError(null);
      setStatisticsLoading(false);
      inFlight = false;
    };
    const fail = (error: unknown) => {
      if (disposed || (error instanceof Error && error.name === "AbortError")) return;
      setStatisticsError(error instanceof Error ? error.message : "生产统计计算失败");
      setStatisticsLoading(false);
      inFlight = false;
    };
    const calculate = () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const state = statisticsGameRef.current;
      const requestId = statisticsRequestIdRef.current + 1;
      statisticsRequestIdRef.current = requestId;
      if (typeof Worker !== "undefined") {
        if (!worker) {
          worker = new Worker(new URL("../game/statistics.worker.ts", import.meta.url), { type: "module", name: "factory-statistics" });
          worker.onmessage = (event: MessageEvent<StatisticsWorkerResponse>) => {
            if (disposed || event.data.id !== statisticsRequestIdRef.current) return;
            if (!event.data.statistics || event.data.error) {
              fail(new Error(event.data.error ?? "统计 Worker 未返回有效结果"));
              return;
            }
            finish(event.data.statistics, event.data.sampledAtSeconds, event.data.durationMs);
          };
          worker.onerror = () => {
            worker?.terminate();
            worker = null;
            inFlight = false;
            fallbackController = new AbortController();
            const startedAt = performance.now();
            void calculateFactoryStatisticsAsync(state, planetScope, { signal: fallbackController.signal })
              .then((result) => finish(result, state.elapsedSeconds, performance.now() - startedAt))
              .catch(fail);
          };
        }
        const request: StatisticsWorkerRequest = {
          id: requestId,
          state,
          planetScope,
          registry: contentPackRuntimeSnapshot,
        };
        try {
          worker.postMessage(request);
        } catch (error) {
          worker.terminate();
          worker = null;
          inFlight = false;
          fail(error);
        }
        return;
      }
      fallbackController = new AbortController();
      const startedAt = performance.now();
      void calculateFactoryStatisticsAsync(state, planetScope, { signal: fallbackController.signal })
        .then((result) => finish(result, state.elapsedSeconds, performance.now() - startedAt))
        .catch(fail);
    };

    const initialTimer = window.setTimeout(calculate, 0);
    const refreshTimer = window.setInterval(calculate, 1_000);
    return () => {
      disposed = true;
      statisticsRequestIdRef.current += 1;
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      fallbackController?.abort();
      worker?.terminate();
    };
  }, [contentPackRuntimeSnapshot.fingerprint, planetScope, statisticsRequired]);
  const galactic = useMemo(() => open && tab === "galaxy" ? getGalacticIndustrySnapshot(game) : null, [game, open, tab]);
  const scopedProductionHistory = useMemo(() => planetScope === "all"
    ? game.productionHistory
    : game.productionHistory.map((sample) => ({
      ...sample,
      productionPerMinute: sample.planetProductionPerMinute?.[planetScope] ?? {},
      consumptionPerMinute: sample.planetConsumptionPerMinute?.[planetScope] ?? {},
    })), [game.productionHistory, planetScope]);
  const productionWindow = useMemo(() => {
    const fallbackProduction = Object.fromEntries(statistics.items.map((item) => [item.itemId, item.productionPerMinute])) as Partial<Record<ItemId, number>>;
    const fallbackConsumption = Object.fromEntries(statistics.items.map((item) => [item.itemId, item.consumptionPerMinute])) as Partial<Record<ItemId, number>>;
    return calculateProductionWindowSnapshot(scopedProductionHistory, productionWindowId, fallbackProduction, fallbackConsumption,
      planetScope === "all" ? game.totalProduced : {});
  }, [game.totalProduced, planetScope, productionWindowId, scopedProductionHistory, statistics.items]);
  const productionItems = useMemo(() => {
    const currentById = new Map(statistics.items.map((item) => [item.itemId, item]));
    const ids = new Set<ItemId>([
      ...currentById.keys(),
      ...Object.keys(productionWindow.production) as ItemId[],
      ...Object.keys(productionWindow.consumption) as ItemId[],
    ]);
    return [...ids].map((itemId): ItemStatistics => {
      const current = currentById.get(itemId);
      const productionPerMinute = productionWindow.production[itemId] ?? 0;
      const consumptionPerMinute = productionWindow.consumption[itemId] ?? 0;
      return {
        itemId,
        productionPerMinute,
        consumptionPerMinute,
        netPerMinute: productionPerMinute - consumptionPerMinute,
        inventory: current?.inventory ?? 0,
        producerCount: current?.producerCount ?? 0,
        consumerCount: current?.consumerCount ?? 0,
        blockedProducerCount: current?.blockedProducerCount ?? 0,
      };
    });
  }, [productionWindow, statistics.items]);
  const items = useMemo(() => sortItems(productionItems.filter((item) => {
    if (query && !getItem(item.itemId).name.includes(query.trim())) return false;
    if (filter === "producing") return item.productionPerMinute > 0;
    if (filter === "deficit") return item.netPerMinute < -0.005;
    if (filter === "blocked") return item.blockedProducerCount > 0;
    return true;
  }), sort), [filter, productionItems, query, sort]);
  const productionTotals = useMemo(() => productionItems.reduce((totals, item) => ({
    production: totals.production + item.productionPerMinute,
    consumption: totals.consumption + item.consumptionPerMinute,
  }), { production: 0, consumption: 0 }), [productionItems]);
  const activeTrendItemId = useMemo(() => {
    if (trendItemId && items.some((item) => item.itemId === trendItemId)) return trendItemId;
    return items[0]?.itemId ?? null;
  }, [items, trendItemId]);
  const productionTrend = useMemo(() => activeTrendItemId && productionWindowId !== "total" && productionWindowId !== "second"
    ? createProductionTrendSeries(scopedProductionHistory, productionWindowId, activeTrendItemId)
    : [], [activeTrendItemId, productionWindowId, scopedProductionHistory]);
  const productionTrendMaximum = useMemo(() => Math.max(1, ...productionTrend.flatMap((point) => [point.productionPerMinute, point.consumptionPerMinute])), [productionTrend]);
  const toggleColumnSort = (key: "production" | "consumption") => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
  }));
  const selectedPlan = tab === "planning" ? game.productionPlans.find((plan) => plan.id === selectedPlanId) ?? game.productionPlans[0] ?? null : null;
  const planResult = useMemo(() => open && tab === "planning" && selectedPlan ? calculateProductionPlan(game, selectedPlan) : null, [game, open, selectedPlan, tab]);
  const targetHistory = useMemo(() => open && tab === "planning" && selectedPlan ? game.productionHistory.map((sample) => ({
    elapsedSeconds: sample.elapsedSeconds,
    production: sample.productionPerMinute[selectedPlan.itemId] ?? 0,
    consumption: sample.consumptionPerMinute[selectedPlan.itemId] ?? 0,
    inventory: sample.inventory[selectedPlan.itemId] ?? 0,
  })).slice(-60) : [], [game.productionHistory, open, selectedPlan, tab]);
  const efficiencyHistory = useMemo(() => open && tab === "efficiency" ? game.productionHistory.slice(-90).map((sample) => ({
    elapsedSeconds: sample.elapsedSeconds,
    machine: sample.machineEfficiency ?? 0,
    logistics: sample.logisticsEfficiency ?? 0,
    power: sample.powerEfficiency ?? (sample.demandKw > 0 ? 0 : 1),
    activeMachines: sample.activeMachines ?? 0,
    blockedMachines: sample.blockedMachines ?? 0,
  })) : [], [game.productionHistory, open, tab]);
  const latestEfficiency = efficiencyHistory.at(-1);

  useEffect(() => {
    if (open && focusTab) setTab(focusTab);
  }, [focusTab, open]);

  if (!open) return null;
  const activeStatisticsPlanet = getPlanet(game.activePlanetId);
  const generationUtilization = game.metrics.generationKw > 0
    ? Math.min(100, game.metrics.demandKw / game.metrics.generationKw * 100)
    : game.metrics.demandKw > 0 ? 100 : 0;

  return (
    <WorkspaceFrame className={`statistics-workspace${mobile ? " mobile-workspace mobile-statistics" : ""}`} ariaLabel="生产统计" onRequestClose={onClose}>
      <header className="statistics-header">
          <div className="statistics-title">
          <i><BarChart3 size={20} /></i>
          <div><span>{planetScope === "all" ? "全星区" : `${getPlanetDisplayName(game, planetScope)} · ${getStarSystem(getPlanet(planetScope).systemId).name}`} · 星系物流</span><strong>生产统计</strong></div>
        </div>
        <div className="statistics-headline">
          <span>生产 <strong><ProductionStatisticValue value={productionTotals.production} suffix={productionWindow.window.suffix} showSuffix /></strong></span>
          <span>消耗 <strong><ProductionStatisticValue value={productionTotals.consumption} suffix={productionWindow.window.suffix} showSuffix /></strong></span>
          <span className={statistics.issues.length > 0 ? "has-issues" : ""}>异常 <strong>{statistics.issues.length}</strong></span>
        </div>
        <button className="statistics-close" type="button" onClick={onClose} title="关闭生产统计" aria-label="关闭生产统计"><X size={18} /></button>
      </header>

      {mobile ? <section className="mobile-statistics-overview" aria-label="生产概览"><div><span>生产</span><strong><ProductionStatisticValue value={productionTotals.production} suffix={productionWindow.window.suffix} showSuffix /></strong></div><div><span>消耗</span><strong><ProductionStatisticValue value={productionTotals.consumption} suffix={productionWindow.window.suffix} showSuffix /></strong></div><div className={statistics.issues.length > 0 ? "warning" : ""}><span>异常</span><strong>{statistics.issues.length}</strong></div><div><span>供电</span><strong>{Math.round(game.metrics.powerFactor * 100)}%</strong></div></section> : null}

      <nav className="statistics-tabs" role="tablist" aria-label="统计视图">
        <button type="button" role="tab" aria-selected={tab === "management"} className={tab === "management" ? "active" : ""} onClick={() => setTab("management")}><Settings2 size={15} />管理</button>
        <button type="button" role="tab" aria-selected={tab === "production"} className={tab === "production" ? "active" : ""} onClick={() => setTab("production")}><Factory size={15} />生产</button>
        <button type="button" role="tab" aria-selected={tab === "efficiency"} className={tab === "efficiency" ? "active" : ""} onClick={() => setTab("efficiency")}><Gauge size={15} />效率</button>
        <button type="button" role="tab" aria-selected={tab === "networks"} className={tab === "networks" ? "active" : ""} onClick={() => setTab("networks")}><Route size={15} />网络</button>
        <button type="button" role="tab" aria-selected={tab === "planning"} className={tab === "planning" ? "active" : ""} onClick={() => setTab("planning")}><Calculator size={15} />规划 <strong>{game.productionPlans.length}</strong></button>
        <button type="button" role="tab" aria-selected={tab === "power"} className={tab === "power" ? "active" : ""} onClick={() => setTab("power")}><Zap size={15} />电力</button>
        <button type="button" role="tab" aria-selected={tab === "issues"} className={tab === "issues" ? "active" : ""} onClick={() => setTab("issues")}><AlertTriangle size={15} />瓶颈 <strong>{statistics.issues.length}</strong></button>
        <button type="button" role="tab" aria-selected={tab === "galaxy"} className={tab === "galaxy" ? "active" : ""} onClick={() => setTab("galaxy")}><Orbit size={15} />银河 {galactic ? <strong title={formatQuantityExact(galactic.galacticScore)}>{formatQuantityCompact(galactic.galacticScore)}</strong> : null}</button>
      </nav>

      {tab === "management" ? <ProductionManagement
        game={game}
        onFocusEntity={onFocusEntity}
        onFocusBelt={onFocusBeltNetwork}
        onBulkRecipeChange={onBulkRecipeChange}
        onBulkStationSlotApply={onBulkStationSlotApply}
        onCreatePlan={(itemId, targetPerMinute, planetId) => {
          const id = `plan_${game.nextId}`;
          onCreatePlan(itemId, targetPerMinute, planetId);
          setSelectedPlanId(id);
          setTab("planning");
        }}
      /> : null}

      {tab === "production" ? (
        <div className="statistics-content statistics-production">
          <div className="statistics-toolbar">
            <label className="statistics-planet-filter"><span>统计星球</span><select value={planetScope} onChange={(event) => setPlanetScope(event.target.value as PlanetId | "all")} aria-label="选择统计星球"><option value="all">全部星球</option><option value={game.activePlanetId}>当前星球：{getPlanetDisplayName(game, game.activePlanetId)} · {getStarSystem(activeStatisticsPlanet.systemId).name}</option>{PLANET_LIST.filter((planet) => planet.id !== game.activePlanetId).map((planet) => <option value={planet.id} key={planet.id}>{getPlanetDisplayName(game, planet.id)} · {getStarSystem(planet.systemId).name}</option>)}</select></label>
            <label className="statistics-search"><Search size={14} /><StableTextInput draftId="production-statistics-search" value={query} onValueChange={setQuery} placeholder="筛选物品" aria-label="筛选统计物品" /></label>
            <div className="statistics-filter" aria-label="物品统计筛选">
              {(["all", "producing", "deficit", "blocked"] as ItemFilter[]).map((option) => (
                <button type="button" className={filter === option ? "active" : ""} key={option} onClick={() => setFilter(option)}>
                  {{ all: "全部", producing: "生产中", deficit: "净消耗", blocked: "堵塞" }[option]}
                </button>
              ))}
            </div>
            <div className="statistics-production-controls">
              <div className="statistics-window-control" role="group" aria-label={isEnglish ? "Production statistics time range" : "生产统计时间范围"}>
                {PRODUCTION_STATISTICS_WINDOWS.map((window) => <button type="button" className={productionWindowId === window.id ? "active" : ""} aria-pressed={productionWindowId === window.id} key={window.id} onClick={() => setProductionWindowId(window.id)}>{isEnglish ? PRODUCTION_STATISTICS_WINDOW_LABELS_EN[window.id] : window.label}</button>)}
              </div>
              <label className="statistics-sort"><span>排序</span><select value={sort.key} onChange={(event) => {
                const key = event.target.value as ItemSortKey;
                setSort({ key, direction: key === "catalog" || key === "name" ? "asc" : "desc" });
              }}><option value="catalog">目录顺序</option><option value="production">生产量</option><option value="consumption">消耗量</option><option value="net">净增量</option><option value="inventory">库存</option><option value="name">物品名称</option></select></label>
            </div>
          </div>
          <div className={`statistics-sample-status${statisticsError ? " statistics-sample-status--error" : ""}`} role="status">
            {statisticsLoading && !statisticsSample ? "正在后台计算生产统计，页面仍可操作" : statisticsError
              ? `统计失败：${statisticsError}`
              : statisticsSample
                ? `采样于模拟 ${statisticsSample.elapsedSeconds.toFixed(1)} 秒 · 后台计算 ${statisticsSample.durationMs.toFixed(1)} ms · 最多每秒刷新一次`
                : "等待统计采样"}
          </div>
          <section className="production-history-trend" aria-label="生产历史趋势">
            <header>
              <div><TrendingUp size={15} /><span>{productionWindowId === "total" ? "累计总产量" : "历史产量趋势"}</span></div>
              <label><span>物品</span><select value={activeTrendItemId ?? ""} onChange={(event) => setTrendItemId(event.target.value as ItemId)} disabled={items.length === 0} aria-label="选择趋势物品">
                {items.map((item) => <option value={item.itemId} key={item.itemId}>{getItem(item.itemId).name}</option>)}
              </select></label>
            </header>
            {productionWindowId === "total" ? <div className="production-history-total">
              {planetScope !== "all" ? <span>累计总产量仅记录全星区权威值；请选择“全部星球”查看。</span> : activeTrendItemId ? <><ItemMark itemId={activeTrendItemId} /><span>{getItem(activeTrendItemId).name}</span><strong><QuantityValue value={game.totalProduced[activeTrendItemId] ?? 0} /></strong></> : <span>暂无累计生产记录</span>}
            </div> : productionTrend.length > 0 && activeTrendItemId ? <>
              <div className="production-history-chart">
                <span className="production-history-axis production-history-axis--top">{formatProductionStatistic(productionTrendMaximum)}/min</span>
                <span className="production-history-axis production-history-axis--bottom">0</span>
                <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label={`${getItem(activeTrendItemId).name}生产和消耗趋势`}>
                  <line x1="0" x2="100" y1="42" y2="42" />
                  <line x1="0" x2="100" y1="24" y2="24" />
                  <line x1="0" x2="100" y1="6" y2="6" />
                  <polyline className="production-history-line production" points={productionTrendPolyline(productionTrend, "productionPerMinute", productionTrendMaximum)} />
                  <polyline className="production-history-line consumption" points={productionTrendPolyline(productionTrend, "consumptionPerMinute", productionTrendMaximum)} />
                </svg>
              </div>
              <footer><span><i className="production" />生产</span><span><i className="consumption" />消耗</span><strong>{getItem(activeTrendItemId).name}</strong><small>{productionTrend.length} 个压缩采样点 · 从新版本开始记录</small></footer>
            </> : <div className="production-history-empty"><TrendingUp size={20} /><span>模拟运行后开始记录当前时间范围的趋势</span></div>}
          </section>
          <div className={`statistics-table${items.length === 0 ? " statistics-table--empty" : ""}`} data-planet-scope={planetScope}>
            <header><span>物品</span><button type="button" className={sort.key === "production" ? "active" : ""} onClick={() => toggleColumnSort("production")}>生产 {productionWindow.window.suffix}{sort.key === "production" ? sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button><button type="button" className={sort.key === "consumption" ? "active" : ""} onClick={() => toggleColumnSort("consumption")}>消耗 {productionWindow.window.suffix}{sort.key === "consumption" ? sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button><span>净增量 {productionWindow.window.suffix}</span><span>网络库存</span><span>节点</span></header>
            <div>
              {items.length === 0 ? <div className="statistics-empty"><Box size={20} /><span>没有符合条件的物品</span></div> : items.map((item) => (
                <div className={`statistics-row${mobile && expandedItemId === item.itemId ? " statistics-row--expanded" : ""}${activeTrendItemId === item.itemId ? " statistics-row--trend-selected" : ""}`} key={item.itemId}>
                  <span className="statistics-item"><ItemMark itemId={item.itemId} /><strong>{getItem(item.itemId).name}</strong><button className="statistics-trend-command" type="button" aria-label={`${mobile && expandedItemId === item.itemId ? "收起" : "查看"}${getItem(item.itemId).name}趋势${mobile ? "和详情" : ""}`} aria-pressed={activeTrendItemId === item.itemId} aria-expanded={mobile ? expandedItemId === item.itemId : undefined} onClick={() => { setTrendItemId(item.itemId); if (mobile) setExpandedItemId((current) => current === item.itemId ? null : item.itemId); }}><TrendingUp size={14} /><span>{mobile && expandedItemId === item.itemId ? "收起" : "趋势"}</span></button></span>
                  <span className="rate-positive"><ProductionStatisticValue value={item.productionPerMinute} suffix={productionWindow.window.suffix} sign="+" /></span>
                  <span className="rate-negative"><ProductionStatisticValue value={item.consumptionPerMinute} suffix={productionWindow.window.suffix} sign="-" /></span>
                  <span className={item.netPerMinute > 0.005 ? "rate-positive" : item.netPerMinute < -0.005 ? "rate-negative" : "rate-neutral"}><ProductionStatisticValue value={item.netPerMinute} suffix={productionWindow.window.suffix} sign={item.netPerMinute > 0 ? "+" : item.netPerMinute < 0 ? "-" : ""} /></span>
                  <span><QuantityValue value={item.inventory} /></span>
                  <span className={item.blockedProducerCount > 0 ? "node-count node-count--blocked" : "node-count"}>{item.producerCount} / {item.consumerCount}{item.blockedProducerCount > 0 ? ` · ${item.blockedProducerCount} 堵塞` : ""}</span>
                  {mobile && expandedItemId === item.itemId ? <small className="statistics-row-detail">生产 {formatProductionStatistic(item.productionPerMinute)}{productionWindow.window.suffix} · 消耗 {formatProductionStatistic(item.consumptionPerMinute)}{productionWindow.window.suffix} · {item.producerCount} 个生产节点 / {item.consumerCount} 个消费节点</small> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "efficiency" ? (
        <div className="statistics-content statistics-efficiency">
          <section className="efficiency-summary-band">
            <div><span>设备效率</span><strong>{Math.round((latestEfficiency?.machine ?? 0) * 100)}%</strong><small>运行设备 {latestEfficiency?.activeMachines ?? 0}</small></div>
            <div><span>传送带利用率</span><strong>{Math.round((latestEfficiency?.logistics ?? 0) * 100)}%</strong><small>连续网络实时流量</small></div>
            <div><span>供电效率</span><strong>{Math.round((latestEfficiency?.power ?? 1) * 100)}%</strong><small>受电负载占比</small></div>
            <div className={(latestEfficiency?.blockedMachines ?? 0) > 0 ? "warning" : ""}><span>停机设备</span><strong>{latestEfficiency?.blockedMachines ?? 0}</strong><small>缺料、堵塞或断电</small></div>
          </section>
          <section className="efficiency-curve">
            <header><div><TrendingUp size={15} /><span>生产效率曲线</span></div><small>{efficiencyHistory.length > 0 ? `最近 ${efficiencyHistory.length * 10} 秒 · 每 10 秒采样` : "等待生产采样"}</small></header>
            {efficiencyHistory.length > 1 ? <><svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label="设备、物流和供电效率曲线">
              <line x1="0" x2="100" y1="42" y2="42" className="efficiency-curve-grid" />
              <line x1="0" x2="100" y1="23" y2="23" className="efficiency-curve-grid" />
              <line x1="0" x2="100" y1="4" y2="4" className="efficiency-curve-grid" />
              <polyline className="efficiency-curve-machine" points={efficiencyPoints(efficiencyHistory.map((sample) => sample.machine))} />
              <polyline className="efficiency-curve-logistics" points={efficiencyPoints(efficiencyHistory.map((sample) => sample.logistics))} />
              <polyline className="efficiency-curve-power" points={efficiencyPoints(efficiencyHistory.map((sample) => sample.power))} />
            </svg><footer><span><i className="machine" />设备效率</span><span><i className="logistics" />传送带利用率</span><span><i className="power" />供电效率</span><strong>{efficiencyHistory.at(-1)?.elapsedSeconds.toFixed(0)} s</strong></footer></> : <div className="efficiency-curve-empty"><Gauge size={22} /><span>模拟运行 20 秒后会显示效率趋势</span></div>}
          </section>
          <section className="efficiency-reading-guide">
            <header><Gauge size={14} /><span>当前判断</span></header>
            <div>{(latestEfficiency?.machine ?? 0) < 0.4 ? <span className="warning">设备效率偏低：优先检查缺料、输出堵塞和电力。</span> : <span className="ready">设备生产稳定。</span>}{(latestEfficiency?.logistics ?? 0) > 0.9 ? <span className="warning">传送带接近满载：可升级线路或并行铺设。</span> : <span>物流仍有可用吞吐。</span>}{(latestEfficiency?.power ?? 1) < 0.99 ? <span className="warning">供电不足会压低所有生产周期。</span> : <span>电网供给充足。</span>}</div>
          </section>
        </div>
      ) : null}

      {tab === "networks" ? <NetworkOverview game={game} onFocusBeltNetwork={onFocusBeltNetwork} onBulkBeltUpgrade={onBulkBeltUpgrade} onBulkBeltRoute={onBulkBeltRoute} onBulkBeltConfiguration={onBulkBeltConfiguration} onBulkBeltRemove={onBulkBeltRemove} onBeltHeatmapChange={onBeltHeatmapChange} onAddCanvasBookmark={onAddCanvasBookmark} onRenameCanvasBookmark={onRenameCanvasBookmark} onOpenCanvasBookmark={onOpenCanvasBookmark} onRemoveCanvasBookmark={onRemoveCanvasBookmark} /> : null}

      {tab === "planning" ? (
        <div className="statistics-content production-planning">
          <div className="planning-create-bar">
            <label><span>目标物品</span><select value={planItemId} onChange={(event) => setPlanItemId(event.target.value as ItemId)}>{Object.values(ITEMS).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <label><span>目标产量</span><input type="number" min={0.01} step={1} value={planTarget} onChange={(event) => setPlanTarget(Math.max(0.01, Number(event.target.value)))} /><em>/min</em></label>
            <label><span>规划范围</span><select value={planPlanetId} onChange={(event) => setPlanPlanetId(event.target.value as PlanetId | "all")}><option value="all">全星区</option>{PLANET_LIST.map((planet) => <option value={planet.id} key={planet.id}>{getPlanetDisplayName(game, planet.id)}</option>)}</select></label>
            <button type="button" onClick={() => { const id = `plan_${game.nextId}`; onCreatePlan(planItemId, planTarget, planPlanetId); setSelectedPlanId(id); }}><Plus size={14} />新建方案</button>
          </div>
          {selectedPlan && planResult ? <div className="planning-layout">
            <aside className="planning-list">
              <header><Calculator size={14} /><span>生产目标</span><strong>{game.productionPlans.length}</strong></header>
              <div>{game.productionPlans.map((plan) => <button className={plan.id === selectedPlan.id ? "active" : ""} type="button" key={plan.id} onClick={() => setSelectedPlanId(plan.id)}><ItemMark itemId={plan.itemId} /><span><strong>{plan.name}</strong><small>{plan.targetPerMinute.toFixed(1)}/min · {plan.planetId === "all" ? "全星区" : getPlanetDisplayName(game, plan.planetId)}</small></span></button>)}</div>
            </aside>
            <main className="planning-detail">
              <header className="planning-config">
                <label><span>方案名称</span><StableTextInput commitOnBlur draftId={`production-plan-name:${selectedPlan.id}`} value={selectedPlan.name} onValueChange={(name) => onUpdatePlan(selectedPlan.id, { name })} onBlur={() => clearStableTextDraft(`production-plan-name:${selectedPlan.id}`)} /></label>
                <label><span>目标物品</span><select value={selectedPlan.itemId} onChange={(event) => onUpdatePlan(selectedPlan.id, { itemId: event.target.value as ItemId })}>{Object.values(ITEMS).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                <label><span>产量 / min</span><input type="number" min={0.01} value={selectedPlan.targetPerMinute} onChange={(event) => onUpdatePlan(selectedPlan.id, { targetPerMinute: Number(event.target.value) })} /></label>
                <label><span>范围</span><select value={selectedPlan.planetId} onChange={(event) => onUpdatePlan(selectedPlan.id, { planetId: event.target.value as PlanetId | "all" })}><option value="all">全星区</option>{PLANET_LIST.map((planet) => <option value={planet.id} key={planet.id}>{getPlanetDisplayName(game, planet.id)}</option>)}</select></label>
                <button type="button" onClick={() => { onRemovePlan(selectedPlan.id); setSelectedPlanId(null); }} title="删除生产方案" aria-label="删除生产方案"><Trash2 size={15} /></button>
              </header>
              <div className="planning-summary-band">
                <div><span>理论设备</span><strong>{planResult.totalMachines}</strong></div>
                <div><span>待增设备</span><strong>{planResult.additionalMachines}</strong></div>
                <div><span>新增用电</span><strong><PowerValue valueKw={planResult.totalPowerDemandKw} /></strong></div>
                <div><span>物流吞吐</span><strong>{planResult.totalLogisticsPerMinute.toFixed(1)}/min</strong></div>
                <div><span>首要瓶颈</span><strong>{planResult.limitingItemId ? getItem(planResult.limitingItemId).name : "无"}</strong></div>
              </div>
              <section className="planning-history">
                <header><TrendingUp size={14} /><span>{getItem(selectedPlan.itemId).name}滚动历史</span><strong>{targetHistory.length > 0 ? `${targetHistory.length * 10} 秒` : "等待采样"}</strong></header>
                {targetHistory.length > 1 ? (() => {
                  const max = Math.max(selectedPlan.targetPerMinute, ...targetHistory.map((point) => Math.max(point.production, point.consumption)), 1);
                  const points = (key: "production" | "consumption") => targetHistory.map((point, index) => `${index / Math.max(1, targetHistory.length - 1) * 100},${40 - point[key] / max * 36}`).join(" ");
                  return <div className="planning-chart"><svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={`${getItem(selectedPlan.itemId).name}生产历史曲线`}><line x1="0" y1={40 - selectedPlan.targetPerMinute / max * 36} x2="100" y2={40 - selectedPlan.targetPerMinute / max * 36} className="planning-chart-target" /><polyline points={points("production")} className="planning-chart-production" /><polyline points={points("consumption")} className="planning-chart-consumption" /></svg><div><span>生产</span><span>消耗</span><span>目标 {selectedPlan.targetPerMinute.toFixed(1)}/min</span><strong>库存 <QuantityValue value={targetHistory.at(-1)?.inventory ?? 0} /></strong></div></div>;
                })() : <div className="planning-history-empty"><TrendingUp size={18} /><span>模拟运行 10 秒后开始记录历史曲线</span></div>}
              </section>
              <section className="planning-requirements">
                <header><span>物品 / 来源</span><span>需求</span><span>现有</span><span>缺口</span><span>设备</span><span>库存续航</span></header>
                <div>{planResult.requirements.map((requirement) => {
                  const recipeOptions = getProductionRecipeOptions(game, requirement.itemId);
                  return <div className={requirement.deficitPerMinute > 0.01 ? "planning-requirement planning-requirement--deficit" : "planning-requirement"} key={requirement.itemId}>
                    <span className="planning-requirement-item" style={{ paddingLeft: `${requirement.depth * 12}px` }}><ItemMark itemId={requirement.itemId} /><span><strong>{getItem(requirement.itemId).name}</strong>{recipeOptions.length > 1 ? <select value={selectedPlan.recipeSelections[requirement.itemId] ?? requirement.recipeId} onChange={(event) => onSetPlanRecipe(selectedPlan.id, requirement.itemId, event.target.value as RecipeId)}>{recipeOptions.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.name}</option>)}</select> : <small>{requirement.recipeId ? getRecipe(requirement.recipeId)?.name : "直接采集"} · {getBuilding(requirement.buildingId).shortName}</small>}</span></span>
                    <span>{requirement.requiredPerMinute.toFixed(1)}/min</span><span>{requirement.existingPerMinute.toFixed(1)}/min</span><span>{requirement.deficitPerMinute.toFixed(1)}/min</span><span>{Math.ceil(requirement.machinesRequired)} · +{requirement.additionalMachines}</span><span>{requirement.coverageMinutes === null ? "稳定" : requirement.coverageMinutes < 1 ? `${Math.round(requirement.coverageMinutes * 60)} 秒` : `${requirement.coverageMinutes.toFixed(1)} 分`}</span>
                  </div>;
                })}</div>
              </section>
            </main>
          </div> : <div className="planning-empty"><Route size={28} /><strong>建立第一个生产目标</strong><span>选择目标物品和每分钟产量，规划器会反推完整原料、设备、电力与物流需求。</span></div>}
        </div>
      ) : null}

      {tab === "power" ? (
        <div className="statistics-content statistics-power">
          <div className="power-summary-band">
            <div><span>电力需求</span><strong><PowerValue valueKw={game.metrics.demandKw} /></strong></div>
            <div><span>可用容量</span><strong><PowerValue valueKw={game.metrics.generationKw} /></strong></div>
            <div><span>风力容量</span><strong><PowerValue valueKw={game.metrics.windGenerationKw} /></strong></div>
            <div><span>太阳能容量</span><strong><PowerValue valueKw={game.metrics.solarGenerationKw} /></strong></div>
            <div><span>地热容量</span><strong><PowerValue valueKw={game.metrics.geothermalGenerationKw} /></strong></div>
            <div><span>射线电力</span><strong><PowerValue valueKw={game.metrics.rayGenerationKw} /></strong></div>
            <div><span>火电出力</span><strong><PowerValue valueKw={game.metrics.thermalGenerationKw} /></strong></div>
            <div><span>聚变出力</span><strong><PowerValue valueKw={game.metrics.fusionGenerationKw} /></strong></div>
            <div><span>人造恒星</span><strong><PowerValue valueKw={game.metrics.artificialStarGenerationKw} /></strong></div>
            <div><span>供电效率</span><strong>{Math.round(game.metrics.powerFactor * 100)}%</strong></div>
            <div><span>燃料续航</span><strong>{reserveTime(game.metrics.fuelReserveSeconds)}</strong></div>
            <div><span>储能水平</span><strong>{game.metrics.storedEnergyMj.toFixed(1)} / {game.metrics.storageCapacityMj.toFixed(0)} MJ</strong></div>
            <div><span>储能充电</span><strong><PowerValue valueKw={game.metrics.storageChargeKw} /></strong></div>
            <div><span>储能放电</span><strong><PowerValue valueKw={game.metrics.storageDischargeKw} /></strong></div>
            <div><span>在轨太阳帆</span><strong><QuantityValue value={game.dysonSwarm.sailsInOrbit} /></strong></div>
            <div><span>戴森云功率</span><strong><PowerValue valueKw={game.dysonSwarm.generationKw} /></strong></div>
            <div><span>永久结构点</span><strong><QuantityValue value={game.dysonSphere.structurePoints} /></strong></div>
            <div><span>壳面太阳帆</span><strong><QuantityValue value={game.dysonSphere.shellSails} /></strong></div>
            <div><span>戴森球功率</span><strong><PowerValue valueKw={game.dysonSphere.generationKw} /></strong></div>
          </div>
          <div className="grid-load"><i><b style={{ width: `${generationUtilization}%` }} /></i><span>容量利用率</span><strong>{Math.round(generationUtilization)}%</strong></div>
          <section className="power-grid-ledger">
            <header><span>独立电网域</span><span>供电效率</span><span>负载 / 容量</span><span>范围内设备</span></header>
            {POWER_GRID_IDS.map((gridId) => {
              const metrics = getPowerGridMetrics(game, game.activePlanetId, gridId);
              return <div className="power-grid-row" key={gridId}><strong>{POWER_GRID_LABELS[gridId]}</strong><span className={metrics.powerFactor < 0.999 ? "warning" : ""}>{Math.round(metrics.powerFactor * 100)}%</span><span><PowerValue valueKw={metrics.demandKw} /> / <PowerValue valueKw={metrics.generationKw} /></span><span>{metrics.connectedEntities} · 断开 {metrics.disconnectedEntities}</span></div>;
            })}
          </section>
          <section className="planet-profile-ledger">
            <header><span>当前行星工业档案</span><strong>种子 #{game.galaxy.seed}</strong></header>
            {(() => { const profile = getPlanetIndustrialProfile(game, game.activePlanetId); return <div className="planet-profile-grid"><span>矿脉储量 <strong>{Math.round(profile.reserveScale * 100)}%</strong></span><span>采矿速度 <strong>{Math.round(profile.miningMultiplier * 100)}%</strong></span><span>风力 <strong>{Math.round(profile.windMultiplier * 100)}%</strong></span><span>光照 <strong>{Math.round(profile.solarMultiplier * 100)}%</strong></span><span>地热 <strong>{Math.round(profile.geothermalMultiplier * 100)}%</strong></span><span>航程时间 <strong>{Math.round(profile.travelTimeMultiplier * 100)}%</strong></span><span>{profile.tidalLocked ? "潮汐锁定" : "自转周期"} <strong>{profile.tidalLocked ? "是" : "常规"}</strong></span><span>专属加成 <strong>{profile.specializationName}</strong></span></div>; })()}
          </section>
          <section className="power-grid-ledger resource-reserve-ledger">
            <header><span>资源储量统计</span><span>资源状态</span><span>剩余 / 初始</span><span>剩余比例</span></header>
            {game.entities.filter((entity) => entity.planetId === game.activePlanetId && entity.kind === "vein" && entity.resourceId).map((entity) => {
              const reserve = getResourceReserveSnapshot(game, entity)!;
              return <div className="power-grid-row" key={entity.id}><strong>{getItem(entity.resourceId!).name}</strong><span className={reserve.exhausted ? "warning" : ""}>{reserve.infinite ? "无限" : reserve.exhausted ? "资源已枯竭" : "有限资源"}</span><span>{reserve.infinite ? "无限" : <><QuantityValue value={reserve.remaining ?? 0} /> / <QuantityValue value={reserve.capacity ?? 0} /></>}</span><span>{reserve.infinite ? "无限" : `${reserve.remainingPercent}%`}</span></div>;
            })}
          </section>
          <section className="consumer-ledger">
            <header><span>耗电设备</span><span>当前需求</span><span>额定需求</span><span>状态</span></header>
            <div>
              {statistics.powerConsumers.length === 0 ? <div className="statistics-empty"><Zap size={20} /><span>暂无耗电设备</span></div> : statistics.powerConsumers.map((consumer) => (
                <div className="consumer-row" key={consumer.entityId}>
                  <span><strong>{consumer.equipmentName}</strong><small>{consumer.entityId}</small></span>
                  <span><PowerValue valueKw={consumer.activeDemandKw} /></span>
                  <span><PowerValue valueKw={consumer.ratedDemandKw} /></span>
                  <span className={`status-text status-text--${consumer.status.tone}`}>{consumer.status.label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {tab === "issues" ? (
        <div className="statistics-content statistics-issues">
          <header className="issues-heading"><AlertTriangle size={18} /><div><span>需处理设备</span><strong>{statistics.issues.length}</strong></div></header>
          <div className="issue-list">
            {statistics.issues.length === 0 ? <div className="statistics-empty"><CircleCheckBig size={20} /><span>生产网络运行正常</span></div> : statistics.issues.map((issue) => (
              <div className={`issue-row issue-row--${issue.status.tone}`} key={issue.entityId}>
                <i><AlertTriangle size={14} /></i>
                <span><strong>{issue.equipmentName}</strong><small>{issue.processName}</small></span>
                <span>{issue.status.label}</span>
                <code>{issue.entityId}</code>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "galaxy" && galactic ? (
        <div className="statistics-content galactic-industry">
          {!galactic.unlocked ? (
            <div className="galactic-lock"><Orbit size={28} /><strong>银河工业协议尚未解锁</strong><span>完成宇宙矩阵科技后，终局研究、出口项目和长期挂机会在这里接管。</span></div>
          ) : (
            <>
              <section className="galactic-summary-grid">
                <div><span>银河评分</span><strong><QuantityValue value={galactic.galacticScore} /></strong><small>信用 <QuantityValue value={galactic.galacticCredits} /></small></div>
                <div><span>全网生产</span><strong>{galactic.totalProductionPerMinute.toFixed(1)}<small>/min</small></strong><small>库存 <QuantityValue value={galactic.networkInventory} /></small></div>
                <div><span>出口吞吐</span><strong>{galactic.exportedPerMinute.toFixed(1)}<small>/min</small></strong><small>累计 <QuantityValue value={galactic.totalExported} /></small></div>
                <div><span>恒星功率</span><strong><PowerValue valueKw={galactic.dysonGenerationKw} /></strong><small>{galactic.activePlanets} 个殖民地</small></div>
                <div><span>运行设备</span><strong>{galactic.operatingEntities}</strong><small>瓶颈 {galactic.blockedEntities}</small></div>
                <div><span>物流航次</span><strong><QuantityValue value={galactic.logisticsTrips} /></strong><small>无限等级 {galactic.infiniteResearchLevels}</small></div>
              </section>
              {game.quantumLogisticsNetwork?.enabled ? <section className="galactic-panel quantum-network-summary" aria-label="量子物流网络共享库存">
                <header><Sparkles size={15} /><span>量子物流网络</span><strong>全宇宙共享池</strong></header>
                <div className="galactic-summary-grid">
                  <div><span>接入量子塔</span><strong>{game.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station" && entity.quantumMode === "quantum").length}</strong><small>跨星走共享池，本地运输机保留</small></div>
                  <div><span>{isEnglish ? "Instant upload" : "即时上传"}</span><strong>{isEnglish ? "Unlimited" : "不限"}</strong><small>{isEnglish ? "Deposited on delivery; overflow settles at the boundary" : "送达时直接入池；溢出缓存按边界结算"}</small></div>
                  <div><span>共享库存种类</span><strong>{Object.keys(game.quantumLogisticsNetwork.inventory).length}</strong><small>输入先入池再输出</small></div>
                  <div><span>共享库存总量</span><strong>{formatQuantityCompact(Object.values(game.quantumLogisticsNetwork.inventory).reduce((sum, value) => BigInt(sum) + BigInt(value), 0n))}</strong><small>精确值 {formatQuantityExact(Object.values(game.quantumLogisticsNetwork.inventory).reduce((sum, value) => BigInt(sum) + BigInt(value), 0n))}</small></div>
                </div>
              </section> : null}
              <GalacticActivityPanel game={game} status={galacticActivityStatus} />
              {game.endgame.exportInputMode === "legacy-network" ? <section className="galactic-automation-bar">
                <header><span><Gauge size={15} />旧档网络调度</span><strong>{game.endgame.autoDispatch ? "运行中" : "已暂停"}</strong></header>
                <div className="galactic-automation-actions">
                  <button type="button" className={game.endgame.autoDispatch ? "active" : ""} onClick={() => onGalacticDispatchAutomation(!game.endgame.autoDispatch)}>{game.endgame.autoDispatch ? <Pause size={14} /> : <Play size={14} />}{game.endgame.autoDispatch ? "暂停自动调度" : "恢复自动调度"}</button>
                  <div role="group" aria-label="自动调度速率">{([0.25, 0.5, 1] as GalacticDispatchThrottle[]).map((throttle) => <button type="button" className={game.endgame.dispatchThrottle === throttle ? "active" : ""} key={throttle} onClick={() => onGalacticDispatchThrottle(throttle)}>{Math.round(throttle * 100)}%</button>)}</div>
                  <label><input type="checkbox" checked={game.endgame.autoResearch} onChange={(event) => onInfiniteResearchAutomation(event.target.checked)} />无限科技自动续研</label>
                </div>
              </section> : <section className="galactic-automation-bar">
                <header><span><Gauge size={15} />活动物资出口</span><strong>{game.entities.filter((entity) => entity.buildingId === "galactic_material_exporter" && entity.galacticExporterPaused === false).length} 座提交中</strong></header>
                <div className="galactic-automation-actions">
                  <span>四个专用端口的真实交付会写入当前本地存档；本版不会上传服务器。</span>
                  {game.entities.filter((entity) => entity.buildingId === "galactic_material_exporter").map((entity, index) => <div className="galactic-exporter-command" key={entity.id}>
                    <button type="button" className={entity.galacticExporterPaused === false ? "active" : ""} onClick={() => onGalacticExporterPausedChange(entity.id, entity.galacticExporterPaused === false)}>{entity.galacticExporterPaused === false ? <Pause size={14} /> : <Play size={14} />}{entity.galacticExporterPaused === false ? `暂停提交 ${index + 1}` : `开始提交任务 ${index + 1}`}</button>
                    <button type="button" onClick={() => onFocusEntity(entity.id, entity.planetId)}><Focus size={14} />定位设备</button>
                  </div>)}
                  {game.entities.every((entity) => entity.buildingId !== "galactic_material_exporter") ? <span>尚未放置超大型物资出口，请先从施工托盘制造并部署。</span> : null}
                  <label><input type="checkbox" checked={game.endgame.autoResearch} onChange={(event) => onInfiniteResearchAutomation(event.target.checked)} />无限科技自动续研</label>
                </div>
              </section>}
              <div className="galactic-panels">
                <section className="galactic-panel infinite-research-panel">
                  <header><Sparkles size={15} /><span>无限科研</span><strong>长期循环项目</strong></header>
                  <div className="infinite-research-list">
                    {INFINITE_RESEARCH_DEFINITIONS.map((definition) => {
                      const progress = game.endgame.infiniteResearch[definition.id];
                      const active = game.endgame.activeInfiniteResearchId === definition.id;
                      const level = getInfiniteResearchLevel(game, definition.id);
                      const cost = getInfiniteResearchCostString(definition.id, level);
                      const capped = isInfiniteResearchComplete(definition.id, level);
                      return <button type="button" className={active ? "active" : ""} disabled={capped} key={definition.id} onClick={() => onSelectInfiniteResearch(definition.id)} title={`${progress.progress} / ${cost} 宇宙矩阵`}>
                        <i style={{ color: definition.color }}>{definition.symbol}</i><span><strong>{definition.name}</strong><small>Lv.{level}{progress.historicalLevel && progress.historicalLevel > level ? `（历史 Lv.${progress.historicalLevel}）` : ""} · {definition.effect}</small><b><em style={{ width: `${getInfiniteResearchCompletion(progress, definition.id) * 100}%` }} /></b></span><label>{capped ? "已达上限" : active ? <><QuantityValue value={progress.progress} />/<QuantityValue value={cost} /></> : "选择"}</label>
                      </button>;
                    })}
                  </div>
                </section>
                <section className="galactic-panel export-panel">
                  <header><Send size={15} /><span>银河物资出口</span><strong>{game.endgame.exportInputMode === "building" ? "实体端口" : "旧档网络"}</strong></header>
                  <div className="export-project-list">
                    {GALACTIC_EXPORT_DEFINITIONS.map((definition) => {
                      const project = game.endgame.exportProjects[definition.id];
                      const target = getGalacticExportTarget(definition.id, project.level);
                      const progress = Math.min(1, project.delivered / target);
                      return <article className={game.endgame.exportInputMode === "building" || project.enabled ? "active" : ""} key={definition.id}>
                        <header><ItemMark itemId={definition.itemId} /><span><strong>{definition.name}</strong><small>Lv.{project.level} · {definition.summary}</small></span>{game.endgame.exportInputMode === "legacy-network" ? <button type="button" onClick={() => onGalacticExportEnabled(definition.id, !project.enabled)} title={project.enabled ? "暂停出口项目" : "启用出口项目"} aria-label={`${project.enabled ? "暂停" : "启用"}${definition.name}`}>{project.enabled ? <Pause size={13} /> : <Play size={13} />}</button> : <em>专用端口</em>}</header>
                        <div className="export-project-progress"><i><b style={{ width: `${progress * 100}%` }} /></i><span><QuantityValue value={project.delivered} /> / <QuantityValue value={target} /></span><strong>累计 <QuantityValue value={project.totalDelivered} /></strong></div>
                        <footer><div role="group" aria-label={`${definition.name}优先级`}>{([1, 2, 3] as GalacticExportPriority[]).map((priority) => <button type="button" className={project.priority === priority ? "active" : ""} key={priority} onClick={() => onGalacticExportPriority(definition.id, priority)}>P{priority}</button>)}</div>{game.endgame.exportInputMode === "legacy-network" ? <button type="button" onClick={() => onDispatchGalacticExport(definition.id)} title="立即装运一批物资"><Send size={12} />立即装运</button> : <span>由实体建筑交付</span>}</footer>
                      </article>;
                    })}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      ) : null}
    </WorkspaceFrame>
  );
}
