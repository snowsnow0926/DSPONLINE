import { getRecipeMissingTechnology, isRecipeTechnologyAvailable } from "../game/contentRules";
import {
  AlertTriangle,
  Calculator,
  CheckSquare,
  ChevronRight,
  Factory,
  Focus,
  Gauge,
  MapPin,
  PackageSearch,
  Route,
  Search,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ITEMS, PLANET_LIST, RECIPES, buildingSupportsRecipe, getBuilding, getItem, getPlanet } from "../game/content";
import {
  getRecipeCompatibleEntityIds,
  getStationTemplateCompatibleEntityIds,
  isTechnologyCompleted,
} from "../game/engine";
import {
  getProductionManagementSnapshot,
  type ProductionManagementGroup,
  type ProductionManagementRow,
  type ProductionManagementState,
} from "../game/productionManagement";
import type {
  GameState,
  ItemId,
  PlanetId,
  RecipeId,
  StationLogisticsMode,
  StationMinimumLoad,
  StationSlotTemplate,
} from "../game/types";
import { ItemCatalogPicker, RecipeCatalogPicker } from "./CatalogPicker";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { StableTextInput } from "./CompositionSafeInput";

const GROUP_LABELS: Record<ProductionManagementGroup, string> = {
  mining: "采矿",
  smelting: "冶炼",
  manufacturing: "制造",
  chemical: "化工",
  research: "科研",
  logistics: "物流",
  power: "电力",
  other: "其他",
};

const STATE_LABELS: Record<ProductionManagementState, string> = {
  running: "运行中",
  missing: "缺料",
  blocked: "堵塞",
  power: "供电",
  idle: "待机",
  unconfigured: "未配置",
};

interface ProductionManagementProps {
  game: GameState;
  onFocusEntity: (entityId: string, planetId: PlanetId) => void;
  onFocusBelt: (beltId: string, planetId: PlanetId) => void;
  onBulkRecipeChange: (entityIds: string[], recipeId: RecipeId) => void;
  onBulkStationSlotApply: (entityIds: string[], slotIndex: number, template: StationSlotTemplate) => void;
  onCreatePlan: (itemId: ItemId, targetPerMinute: number, planetId: PlanetId | "all") => void;
}

function ItemMark({ itemId }: { itemId: ItemId }) {
  return <ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} className="item-mark" /></ItemHoverCard>;
}

function rowSearchText(row: ProductionManagementRow): string {
  return [
    row.equipmentName,
    row.processName,
    getPlanet(row.planetId).name,
    row.status.label,
    row.diagnosis,
    GROUP_LABELS[row.group],
    ...row.inputItemIds.map((itemId) => getItem(itemId).name),
    ...row.outputItemIds.map((itemId) => getItem(itemId).name),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

function traceRoots(game: GameState, entityIds: string[]): string {
  const labels = entityIds.slice(0, 3).map((entityId) => {
    const entity = game.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return entityId;
    if (entity.kind === "vein" && entity.resourceId) return getItem(entity.resourceId).name;
    return entity.buildingId ? `${getPlanet(entity.planetId).name} · ${getBuilding(entity.buildingId).shortName}` : entity.id;
  });
  return labels.length > 0 ? labels.join("、") : "尚未追溯到原料源";
}

export function ProductionManagement({ game, onFocusEntity, onFocusBelt, onBulkRecipeChange, onBulkStationSlotApply, onCreatePlan }: ProductionManagementProps) {
  const snapshot = useMemo(() => getProductionManagementSnapshot(game), [game]);
  const [query, setQuery] = useState("");
  const [planetFilter, setPlanetFilter] = useState<PlanetId | "all">("all");
  const [groupFilter, setGroupFilter] = useState<ProductionManagementGroup | "all">("all");
  const [stateFilter, setStateFilter] = useState<ProductionManagementState | "all">("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchRecipeId, setBatchRecipeId] = useState<RecipeId | undefined>();
  const [slotIndex, setSlotIndex] = useState(0);
  const [slotItemId, setSlotItemId] = useState<ItemId>("iron_ore");
  const [localMode, setLocalMode] = useState<StationLogisticsMode>("supply");
  const [remoteMode, setRemoteMode] = useState<StationLogisticsMode>("storage");
  const [minimumLoad, setMinimumLoad] = useState<StationMinimumLoad>(0.5);
  const [priority, setPriority] = useState<0 | 1 | 2>(1);
  const [minStock, setMinStock] = useState(0);
  const [maxStock, setMaxStock] = useState(0);
  const [planItemId, setPlanItemId] = useState<ItemId>("electromagnetic_matrix");
  const [planTarget, setPlanTarget] = useState(60);
  const [planPlanetId, setPlanPlanetId] = useState<PlanetId | "all">("all");
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const rows = useMemo(() => snapshot.rows.filter((row) => {
    if (planetFilter !== "all" && row.planetId !== planetFilter) return false;
    if (groupFilter !== "all" && row.group !== groupFilter) return false;
    if (stateFilter !== "all" && row.state !== stateFilter) return false;
    return !term || rowSearchText(row).includes(term);
  }), [groupFilter, planetFilter, snapshot.rows, stateFilter, term]);
  const rowIds = rows.map((row) => row.entityId);
  const selectedRows = useMemo(() => snapshot.rows.filter((row) => selectedIds.includes(row.entityId)), [selectedIds, snapshot.rows]);
  const selectedMachines = useMemo(() => selectedRows.filter((row) => row.buildingId && row.group !== "mining" && row.group !== "logistics" && row.group !== "power"), [selectedRows]);
  const selectedStations = useMemo(() => selectedRows.filter((row) => row.buildingId === "planetary_logistics_station" || row.buildingId === "interstellar_logistics_station"), [selectedRows]);
  const recipeOptions = useMemo(() => Object.values(RECIPES).filter((recipe) =>
    (isRecipeTechnologyAvailable(recipe, game.research.completedTechIds)) &&
    selectedMachines.some((row) => row.buildingId && buildingSupportsRecipe(row.buildingId, recipe))), [game, selectedMachines]);
  const recipeCompatibleIds = batchRecipeId ? getRecipeCompatibleEntityIds(game, selectedIds, batchRecipeId) : [];
  const slotTemplate: StationSlotTemplate = { itemId: slotItemId, localMode, remoteMode, minimumLoad, minStock, maxStock, priority };
  const stationCompatibleIds = getStationTemplateCompatibleEntityIds(game, selectedIds, slotIndex, slotTemplate);

  useEffect(() => {
    setSelectedIds((current) => current.filter((entityId) => snapshot.rows.some((row) => row.entityId === entityId)));
  }, [snapshot.rows]);

  useEffect(() => {
    setBatchRecipeId((current) => current && recipeOptions.some((recipe) => recipe.id === current) ? current : recipeOptions[0]?.id);
  }, [recipeOptions]);

  const allVisibleSelected = rowIds.length > 0 && rowIds.every((entityId) => selectedIds.includes(entityId));
  const toggleVisible = () => setSelectedIds((current) => {
    if (allVisibleSelected) return current.filter((entityId) => !rowIds.includes(entityId));
    return [...new Set([...current, ...rowIds])];
  });
  const toggleRow = (entityId: string) => setSelectedIds((current) => current.includes(entityId)
    ? current.filter((candidate) => candidate !== entityId)
    : [...current, entityId]);

  return (
    <div className="statistics-content production-management">
      <section className="production-management-summary">
        <div><span>全星球设备</span><strong>{snapshot.rows.length}</strong><small>{snapshot.planets.length} 个已殖民行星</small></div>
        <div><span>正在运行</span><strong>{snapshot.runningCount}</strong><small>{snapshot.rows.length > 0 ? Math.round(snapshot.runningCount / snapshot.rows.length * 100) : 0}% 节点在线</small></div>
        <div className={snapshot.missingCount > 0 ? "warning" : ""}><span>缺料链</span><strong>{snapshot.missingCount}</strong><small>可追踪输入与原矿</small></div>
        <div className={snapshot.blockedCount > 0 ? "warning" : ""}><span>输出堵塞</span><strong>{snapshot.blockedCount}</strong><small>可定位线路与下游</small></div>
      </section>

      <section className="planet-production-strip" aria-label="行星产能总览">
        {snapshot.planets.map((planet) => <button type="button" className={planetFilter === planet.planetId ? "active" : ""} key={planet.planetId} onClick={() => setPlanetFilter((current) => current === planet.planetId ? "all" : planet.planetId)}>
          <span><MapPin size={12} />{getPlanet(planet.planetId).name}</span><strong>{planet.runningCount}/{planet.entityCount}</strong><small>{planet.productionRate.toFixed(1)}/min · 效率 {Math.round(planet.averageUtilization * 100)}% · 异常 {planet.issueCount}</small>
        </button>)}
      </section>

      <div className="production-management-toolbar">
        <label className="statistics-search"><Search size={14} /><StableTextInput draftId="production-management-search" value={query} onValueChange={setQuery} placeholder="设备、配方、物品、状态" aria-label="搜索生产设备" /></label>
        <label><span>行星</span><select value={planetFilter} onChange={(event) => setPlanetFilter(event.target.value as PlanetId | "all")} aria-label="筛选生产行星"><option value="all">全星区</option>{snapshot.planets.map((planet) => <option value={planet.planetId} key={planet.planetId}>{getPlanet(planet.planetId).name}</option>)}</select></label>
        <label><span>设备</span><select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value as ProductionManagementGroup | "all")} aria-label="筛选设备类型"><option value="all">全部类型</option>{Object.entries(GROUP_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>状态</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as ProductionManagementState | "all")} aria-label="筛选设备状态"><option value="all">全部状态</option>{Object.entries(STATE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>

      <section className={`production-management-batch${selectedIds.length > 0 ? " production-management-batch--active" : ""}`} aria-label="生产设备批量操作">
        <div className="production-batch-selection">
          <button type="button" onClick={toggleVisible}><CheckSquare size={14} />{allVisibleSelected ? "取消当前结果" : "选择当前结果"}</button>
          <strong>{selectedIds.length} 个节点</strong>
          {selectedIds.length > 0 ? <button type="button" onClick={() => setSelectedIds([])}>清空</button> : null}
        </div>
        {selectedIds.length > 0 ? <div className="production-batch-recipe">
          <header><Factory size={13} /><span>批量配方</span><strong>{recipeCompatibleIds.length}/{selectedMachines.length}</strong></header>
          {recipeOptions.length > 0 ? <RecipeCatalogPicker compact value={batchRecipeId} recipes={recipeOptions} onChange={setBatchRecipeId} /> : <span className="production-batch-empty">请选择生产设备</span>}
          <button type="button" disabled={!batchRecipeId || recipeCompatibleIds.length === 0} onClick={() => batchRecipeId && onBulkRecipeChange(recipeCompatibleIds, batchRecipeId)}><Settings2 size={13} />应用兼容设备</button>
        </div> : null}
        {selectedIds.length > 0 ? <details className="production-batch-station">
          <summary><Route size={13} /><span>物流槽模板</span><strong>{stationCompatibleIds.length}/{selectedStations.length}</strong><ChevronRight size={13} /></summary>
          <div>
            <label><span>槽位</span><select value={slotIndex} onChange={(event) => setSlotIndex(Number(event.target.value))} aria-label="批量物流槽位">{[0, 1, 2, 3, 4].map((index) => <option value={index} key={index}>槽位 {index + 1}</option>)}</select></label>
            <ItemCatalogPicker value={slotItemId} items={Object.values(ITEMS)} label="批量物流物品" onChange={(itemId) => itemId && setSlotItemId(itemId)} />
            <label><span>本地</span><select value={localMode} onChange={(event) => setLocalMode(event.target.value as StationLogisticsMode)}><option value="supply">供应</option><option value="demand">需求</option><option value="storage">仓储</option></select></label>
            <label><span>星际</span><select value={remoteMode} onChange={(event) => setRemoteMode(event.target.value as StationLogisticsMode)}><option value="supply">供应</option><option value="demand">需求</option><option value="storage">仓储</option></select></label>
            <label><span>起运</span><select value={minimumLoad} onChange={(event) => setMinimumLoad(Number(event.target.value) as StationMinimumLoad)}>{([0.1, 0.25, 0.5, 1] as StationMinimumLoad[]).map((load) => <option value={load} key={load}>{Math.round(load * 100)}%</option>)}</select></label>
            <label><span>优先</span><select value={priority} onChange={(event) => setPriority(Number(event.target.value) as 0 | 1 | 2)}><option value={2}>高</option><option value={1}>标准</option><option value={0}>低</option></select></label>
            <label><span>保留</span><input type="number" min={0} value={minStock} onChange={(event) => setMinStock(Math.max(0, Number(event.target.value)))} /></label>
            <label><span>上限</span><input type="number" min={0} value={maxStock} onChange={(event) => setMaxStock(Math.max(0, Number(event.target.value)))} /></label>
            <button type="button" disabled={stationCompatibleIds.length === 0} onClick={() => onBulkStationSlotApply(stationCompatibleIds, slotIndex, slotTemplate)}><SlidersHorizontal size={13} />应用槽位模板</button>
          </div>
        </details> : null}
      </section>

      <section className="production-target-planner">
        <header><Calculator size={14} /><span>目标产量反推</span></header>
        <ItemCatalogPicker value={planItemId} items={Object.values(ITEMS)} label="选择目标物品" onChange={(itemId) => itemId && setPlanItemId(itemId)} />
        <label><input type="number" min={0.01} step={1} value={planTarget} onChange={(event) => setPlanTarget(Math.max(0.01, Number(event.target.value)))} aria-label="目标每分钟产量" /><span>/min</span></label>
        <select value={planPlanetId} onChange={(event) => setPlanPlanetId(event.target.value as PlanetId | "all")} aria-label="目标产量规划范围"><option value="all">全星区</option>{PLANET_LIST.map((planet) => <option value={planet.id} key={planet.id}>{planet.name}</option>)}</select>
        <button type="button" onClick={() => onCreatePlan(planItemId, planTarget, planPlanetId)}><Calculator size={13} />生成完整需求</button>
      </section>

      <section className="production-management-ledger">
        <header><span>选择 / 设备</span><span>流程与状态</span><span>效率与产能</span><span>缺料 / 堵塞来源</span><span>定位</span></header>
        <div>{rows.length === 0 ? <div className="statistics-empty"><PackageSearch size={22} /><span>没有符合条件的生产设备</span></div> : rows.map((row) => {
          const problemTrace = row.inputTraces.find((trace) => trace.buffered < trace.required) ?? row.outputTraces[0];
          const problemBeltId = problemTrace?.focusBeltId;
          return <article className={`production-management-row production-management-row--${row.state}${selectedIds.includes(row.entityId) ? " production-management-row--selected" : ""}`} key={row.entityId}>
            <label><input type="checkbox" checked={selectedIds.includes(row.entityId)} onChange={() => toggleRow(row.entityId)} /><span><strong>{row.equipmentName} ×{row.unitCount}</strong><small><MapPin size={10} />{getPlanet(row.planetId).name} · {GROUP_LABELS[row.group]}</small></span></label>
            <span><strong>{row.processName}</strong><small className={`status-text status-text--${row.status.tone}`}>{row.status.label}</small></span>
            <span className="production-management-rate"><i><b style={{ width: `${Math.round(row.utilization * 100)}%` }} /></i><strong>{Math.round(row.utilization * 100)}% · {row.productionRate.toFixed(1)}/min</strong><small>{row.inputItemIds.length} 输入 · {row.outputItemIds.length} 输出</small></span>
            <div className="production-management-diagnosis">
              <strong>{row.diagnosis}</strong>
              {(row.inputTraces.length > 0 || row.outputTraces.length > 0) ? <details><summary>展开物料路径</summary><div>
                {row.inputTraces.map((trace) => <p className={trace.buffered < trace.required ? "warning" : ""} key={`input-${trace.itemId}`}><ItemMark itemId={trace.itemId} /><span><strong>{getItem(trace.itemId).name} {trace.buffered}/{trace.required}</strong><small>{trace.label} · 入线 {trace.inboundBeltIds.length} · 上游 {trace.upstreamEntityIds.length}</small><em>原料源：{traceRoots(game, trace.rootSourceEntityIds)}</em></span>{trace.focusEntityId ? <button type="button" onClick={() => { const target = game.entities.find((entity) => entity.id === trace.focusEntityId); if (target) onFocusEntity(target.id, target.planetId); }} title="定位上游设备" aria-label={`定位${getItem(trace.itemId).name}上游设备`}><Focus size={12} /></button> : null}</p>)}
                {row.outputTraces.map((trace) => <p className={row.state === "blocked" ? "warning" : ""} key={`output-${trace.itemId}`}><ItemMark itemId={trace.itemId} /><span><strong>{getItem(trace.itemId).name} · 库存 {trace.buffered}</strong><small>{trace.label} · 出线 {trace.outboundBeltIds.length} · 下游 {trace.downstreamEntityIds.length}</small></span>{trace.focusEntityId ? <button type="button" onClick={() => { const target = game.entities.find((entity) => entity.id === trace.focusEntityId); if (target) onFocusEntity(target.id, target.planetId); }} title="定位下游设备" aria-label={`定位${getItem(trace.itemId).name}下游设备`}><Focus size={12} /></button> : null}</p>)}
              </div></details> : <small>{row.status.label}</small>}
            </div>
            <div className="production-management-actions"><button type="button" onClick={() => onFocusEntity(row.entityId, row.planetId)} title={`定位${row.equipmentName}`} aria-label={`定位${row.equipmentName}`}><Focus size={14} /></button>{problemBeltId ? <button type="button" onClick={() => onFocusBelt(problemBeltId, row.planetId)} title="定位问题线路" aria-label={`定位${row.equipmentName}问题线路`}><Route size={14} /></button> : null}</div>
          </article>;
        })}</div>
      </section>
      {snapshot.issueCount > 0 ? <footer className="production-management-footer"><AlertTriangle size={13} /><span>当前有 {snapshot.issueCount} 个供电、缺料或堵塞问题。问题定位会关闭统计面板并切换到对应行星。</span></footer> : <footer className="production-management-footer production-management-footer--ready"><Gauge size={13} /><span>全星球生产节点没有阻断级问题。</span></footer>}
    </div>
  );
}
