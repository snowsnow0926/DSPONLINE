import {
  ArrowRight,
  BookOpen,
  Check,
  Clock3,
  Factory,
  FlaskConical,
  LockKeyhole,
  LocateFixed,
  MapPin,
  Pickaxe,
  Pin,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BUILDINGS, ITEMS, PLANET_LIST, RECIPES, TECHNOLOGIES, getBuilding, getCompatibleRecipeBuildings, getItem, getPlanet, getTechnology } from "../game/content";
import {
  getConsumingRecipes,
  getProducingRecipes,
  getResearchUses,
  getResourceSources,
  getVirtualRecipeResult,
} from "../game/recipeGraph";
import { getRecipeRates } from "../game/recipeGraph";
import { validateContentCatalog } from "../game/content";
import {
  RECIPE_WORKSPACE_PROJECTION_LIMITS,
  recipeWorkspaceSelectorsEqual,
  type RecipeWorkspaceReadModel,
  type RecipeWorkspaceSelector,
} from "../game/recipeWorkspaceReadModel";
import type { BuildingId, ItemId, PlanetId, RecipeDefinition, TechId } from "../game/types";
import { CODEX_SECTION_LABELS, CodexSections, type CodexSection } from "./CodexSections";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { QuantityValue } from "./QuantityValue";
import { StableTextInput, clearStableTextDraft } from "./CompositionSafeInput";
import { WorkspaceFrame } from "./WorkspaceFrame";

type ItemFilter = "all" | "raw" | "solid" | "fluid" | "matrix";

function ItemMark({ itemId }: { itemId: ItemId }) {
  return (
    <ItemHoverCard itemId={itemId}>
      <ItemGlyph itemId={itemId} className="item-mark" />
    </ItemHoverCard>
  );
}

function ItemLink({ itemId, amount, ratePerMinute, onSelect }: {
  itemId: ItemId;
  amount?: number;
  ratePerMinute?: number;
  onSelect: (itemId: ItemId) => void;
}) {
  return (
    <button className="recipe-item-link" type="button" onClick={() => onSelect(itemId)} title={`查看${getItem(itemId).name}`}>
      <ItemGlyph itemId={itemId} className="item-mark" />
      <span>{getItem(itemId).name}</span>
      {amount != null ? <strong>×<QuantityValue value={amount} interactive={false} /></strong> : null}
      {ratePerMinute != null ? <small>{ratePerMinute.toFixed(1)}/min</small> : null}
    </button>
  );
}

function RecipeFlowCard({ recipe, readModel, onSelect, onSelectBuilding, onSelectTechnology }: {
  recipe: RecipeDefinition;
  readModel: RecipeWorkspaceReadModel;
  onSelect: (itemId: ItemId) => void;
  onSelectBuilding?: (buildingId: BuildingId) => void;
  onSelectTechnology?: (techId: TechId) => void;
}) {
  const building = getBuilding(recipe.buildingId);
  const compatibleBuildings = getCompatibleRecipeBuildings(recipe);
  const equipmentLabel = compatibleBuildings.length > 1
    ? `${building.name} +${compatibleBuildings.length - 1} 高阶`
    : building.name;
  const unlocked = !recipe.requiredTechId || readModel.completedTechIds.includes(recipe.requiredTechId);
  const virtualResult = getVirtualRecipeResult(recipe);
  const rates = getRecipeRates(recipe, building.speed);
  return (
    <article className="recipe-method">
      <header>
        <i><Factory size={15} /></i>
        <span><strong>{recipe.name}</strong>{onSelectBuilding ? <button className="recipe-building-link" type="button" title={compatibleBuildings.map((candidate) => candidate.name).join(" / ")} onClick={() => onSelectBuilding(building.id)}>{equipmentLabel}</button> : <small title={compatibleBuildings.map((candidate) => candidate.name).join(" / ")}>{equipmentLabel}</small>}</span>
        <em><Clock3 size={12} />{recipe.duration}s</em>
      </header>
      <div className="recipe-flow">
        <div>
          <small>输入</small>
          {recipe.inputs.length > 0
            ? recipe.inputs.map((input) => <ItemLink itemId={input.itemId} amount={input.amount} ratePerMinute={rates.inputPerMinute[input.itemId]} onSelect={onSelect} key={input.itemId} />)
            : <span className="recipe-flow-empty">{recipe.buildingId === "ray_receiver" ? "戴森系统能量" : "无需物料"}</span>}
        </div>
        <ArrowRight size={17} />
        <div>
          <small>输出</small>
          {recipe.outputs.length > 0
            ? recipe.outputs.map((output) => <ItemLink itemId={output.itemId} amount={output.amount} ratePerMinute={rates.outputPerMinute[output.itemId]} onSelect={onSelect} key={output.itemId} />)
            : <span className="recipe-virtual-output">{virtualResult ?? "流程产出"}</span>}
        </div>
      </div>
      <footer>
        <span>{building.speed.toFixed(2)}× 设备速度 · {rates.cyclesPerMinute.toFixed(1)} 批/min</span>
        {recipe.requiredTechId ? (
          <button type="button" className={unlocked ? "recipe-unlock recipe-unlock--ready" : "recipe-unlock"} onClick={() => recipe.requiredTechId && onSelectTechnology?.(recipe.requiredTechId)}>
            {unlocked ? <Check size={11} /> : <LockKeyhole size={11} />}{getTechnology(recipe.requiredTechId)?.name}
          </button>
        ) : <span className="recipe-unlock recipe-unlock--ready"><Check size={11} />基础配方</span>}
      </footer>
    </article>
  );
}

export function RecipeWorkspace({ open, readOnly = false, readModel, onReadRequest, onClose, focusItemId, onFocus, onLocateProductionLine, mobile = false, mobileSubview, onMobileOpenDetail, onMobileReplaceDetail }: {
  open: boolean;
  readOnly?: boolean;
  readModel: RecipeWorkspaceReadModel | null;
  onReadRequest: (selector: RecipeWorkspaceSelector) => void;
  onClose: () => void;
  focusItemId?: ItemId | null;
  onFocus: (itemId: ItemId | null) => void;
  onLocateProductionLine: (itemId: ItemId, planetId: PlanetId) => void;
  mobile?: boolean;
  mobileSubview?: string | null;
  onMobileOpenDetail?: (subview: string) => void;
  onMobileReplaceDetail?: (subview: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [section, setSection] = useState<CodexSection>("items");
  const [selectedItemId, setSelectedItemId] = useState<ItemId>(focusItemId ?? "iron_ore");
  const [selectedBuildingId, setSelectedBuildingId] = useState<BuildingId>("assembling_machine_mk1");
  const [selectedTechId, setSelectedTechId] = useState<TechId>("electromagnetic_matrix");
  const [selectedPlanetId, setSelectedPlanetId] = useState<PlanetId>(PLANET_LIST[0].id);
  const [itemPage, setItemPage] = useState(0);
  const mobileScrollRef = useRef<HTMLElement | null>(null);
  const mobileScrollPositionRef = useRef(0);
  const previousMobileSubviewRef = useRef<string | null>(null);
  const autoFocusedMobileSubviewRef = useRef<string | null>(null);
  const initializedFromReadModelRef = useRef(false);
  const itemList = useMemo(() => Object.values(ITEMS), [readModel?.registryFingerprint]);
  useEffect(() => {
    if (!readModel || initializedFromReadModelRef.current) return;
    initializedFromReadModelRef.current = true;
    if (!focusItemId && readModel.recipeFocus.itemId) setSelectedItemId(readModel.recipeFocus.itemId);
    setSelectedPlanetId(readModel.activePlanetId);
  }, [focusItemId, readModel]);
  useEffect(() => {
    if (!focusItemId) return;
    setSection("items");
    setSelectedItemId(focusItemId);
    setQuery("");
    clearStableTextDraft("recipe-workspace-search");
    setFilter("all");
  }, [focusItemId]);
  useEffect(() => {
    if (!mobile || !open) return;
    const detailItemId = mobileSubview?.startsWith("item:") ? mobileSubview.slice(5) as ItemId : null;
    const detailBuildingId = mobileSubview?.startsWith("building:") ? mobileSubview.slice(9) as BuildingId : null;
    const detailTechId = mobileSubview?.startsWith("technology:") ? mobileSubview.slice(11) as TechId : null;
    const detailPlanetId = mobileSubview?.startsWith("planet:") ? mobileSubview.slice(7) as PlanetId : null;
    if (detailItemId && ITEMS[detailItemId]) {
      setSection("items");
      setSelectedItemId(detailItemId);
      if (!previousMobileSubviewRef.current) window.requestAnimationFrame(() => { if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0; });
    } else if (detailBuildingId && BUILDINGS[detailBuildingId]) {
      setSection("buildings");
      setSelectedBuildingId(detailBuildingId);
      if (!previousMobileSubviewRef.current) window.requestAnimationFrame(() => { if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0; });
    } else if (detailTechId && TECHNOLOGIES[detailTechId]) {
      setSection("research");
      setSelectedTechId(detailTechId);
      if (!previousMobileSubviewRef.current) window.requestAnimationFrame(() => { if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0; });
    } else if (detailPlanetId && PLANET_LIST.some((planet) => planet.id === detailPlanetId)) {
      setSection("planets");
      setSelectedPlanetId(detailPlanetId);
      if (!previousMobileSubviewRef.current) window.requestAnimationFrame(() => { if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0; });
    } else if (previousMobileSubviewRef.current) {
      window.requestAnimationFrame(() => { if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = mobileScrollPositionRef.current; });
    }
    previousMobileSubviewRef.current = mobileSubview ?? null;
  }, [mobile, mobileSubview, open]);
  useEffect(() => {
    if (!mobile || !open || !focusItemId || !onMobileOpenDetail) return;
    const targetSubview = `item:${focusItemId}`;
    if (mobileSubview === targetSubview || autoFocusedMobileSubviewRef.current === targetSubview) return;
    autoFocusedMobileSubviewRef.current = targetSubview;
    if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0;
    onMobileOpenDetail(targetSubview);
  }, [focusItemId, mobile, mobileSubview, onMobileOpenDetail, open]);
  const visibleItems = useMemo(() => itemList.filter((item) => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    const matchesSearch = !term || `${item.name} ${item.symbol} ${item.id} ${item.description}`.toLocaleLowerCase("zh-CN").includes(term);
    if (!matchesSearch) return false;
    if (filter === "raw") return getResourceSources(item.id).length > 0;
    if (filter === "solid") return item.kind === "solid";
    if (filter === "fluid") return item.kind === "fluid";
    if (filter === "matrix") return item.kind === "matrix";
    return true;
  }), [filter, itemList, query]);
  const itemPageCount = Math.max(1, Math.ceil(visibleItems.length / RECIPE_WORKSPACE_PROJECTION_LIMITS.itemRows));
  const pageItems = useMemo(() => visibleItems.slice(
    itemPage * RECIPE_WORKSPACE_PROJECTION_LIMITS.itemRows,
    (itemPage + 1) * RECIPE_WORKSPACE_PROJECTION_LIMITS.itemRows,
  ), [itemPage, visibleItems]);
  useEffect(() => setItemPage(0), [filter, query]);
  useEffect(() => {
    if (itemPage < itemPageCount) return;
    setItemPage(itemPageCount - 1);
  }, [itemPage, itemPageCount]);
  const requestedSelector = useMemo<RecipeWorkspaceSelector>(() => ({
    itemIds: pageItems.map((item) => item.id),
    selectedItemId,
  }), [pageItems, selectedItemId]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => onReadRequest(requestedSelector), 120);
    return () => window.clearTimeout(timer);
  }, [onReadRequest, open, requestedSelector]);

  if (!open) return null;
  if (!readModel || !recipeWorkspaceSelectorsEqual(readModel.selector, requestedSelector)) {
    return (
      <WorkspaceFrame className="recipe-workspace" ariaLabel="生产资料库" onRequestClose={onClose}>
        <header className="recipe-header">
          <div className="recipe-title"><i><BookOpen size={20} /></i><div><span>星系生产资料库</span><strong>正在读取同一版本的数据…</strong></div></div>
          <button className="recipe-close" type="button" onClick={onClose} title="关闭生产资料库" aria-label="关闭生产资料库"><X size={18} /></button>
        </header>
        <div className="recipe-section-empty">资料库正在等待当前模拟版本的有界只读投影，不会显示旧版本数据。</div>
      </WorkspaceFrame>
    );
  }
  const item = getItem(selectedItemId);
  const sources = getResourceSources(selectedItemId);
  const producingRecipes = getProducingRecipes(selectedItemId);
  const consumingRecipes = getConsumingRecipes(selectedItemId);
  const researchUses = getResearchUses(selectedItemId);
  const upstreamItems = [...new Set(producingRecipes.flatMap((recipe) => recipe.inputs.map((input) => input.itemId)))];
  const downstreamItems = [...new Set(consumingRecipes.flatMap((recipe) => recipe.outputs.map((output) => output.itemId)))];
  const stock = readModel.selectedItem.stock;
  const productionLocations = readModel.selectedItem.productionLocations;
  const currentProductionLocation = productionLocations.find((location) => location.planetId === readModel.activePlanetId);
  const catalogAudit = validateContentCatalog();

  const mobileDetail = Boolean(mobile && mobileSubview);
  const openMobileDetail = (subview: string) => {
    if (!mobile) return;
    if (mobileDetail) onMobileReplaceDetail?.(subview);
    else {
      mobileScrollPositionRef.current = mobileScrollRef.current?.scrollTop ?? 0;
      if (mobileScrollRef.current) mobileScrollRef.current.scrollTop = 0;
      onMobileOpenDetail?.(subview);
    }
  };
  const selectItem = (itemId: ItemId) => {
    setSection("items");
    setSelectedItemId(itemId);
    openMobileDetail(`item:${itemId}`);
  };
  const selectBuilding = (buildingId: BuildingId) => { setSection("buildings"); setSelectedBuildingId(buildingId); openMobileDetail(`building:${buildingId}`); };
  const selectTechnology = (techId: TechId) => { setSection("research"); setSelectedTechId(techId); openMobileDetail(`technology:${techId}`); };
  const selectPlanet = (planetId: PlanetId) => { setSection("planets"); setSelectedPlanetId(planetId); openMobileDetail(`planet:${planetId}`); };

  return (
    <WorkspaceFrame ref={mobile ? mobileScrollRef : undefined} className={`recipe-workspace${section === "items" ? " recipe-workspace--items" : ""}${mobile ? ` mobile-workspace mobile-recipe${mobileDetail ? " mobile-workspace--detail" : ""}` : ""}`} ariaLabel="生产资料库" onRequestClose={onClose}>
      <header className="recipe-header">
        <div className="recipe-title">
          <i><BookOpen size={20} /></i>
          <div><span>星系生产资料库</span><strong>游戏图鉴</strong></div>
        </div>
        <div className="recipe-headline">
          <span>物品 <strong>{itemList.length}</strong></span>
          <span>配方 <strong>{Object.keys(RECIPES).length}</strong></span>
          <span>建筑 <strong>{Object.keys(BUILDINGS).length}</strong></span>
          <span>科技 <strong>{Object.keys(TECHNOLOGIES).length}</strong></span>
          <span className={catalogAudit.valid ? "recipe-audit recipe-audit--valid" : "recipe-audit"} title={catalogAudit.valid ? "内容数据校验通过" : catalogAudit.issues.map((issue) => issue.message).join("；")}>数据 <strong>{catalogAudit.valid ? "OK" : `${catalogAudit.issues.length} 项`}</strong></span>
        </div>
        <button className="recipe-close" type="button" onClick={onClose} title="关闭生产资料库" aria-label="关闭生产资料库"><X size={18} /></button>
      </header>

      {!mobileDetail ? <nav className="codex-section-nav" aria-label="资料库分类">{(Object.keys(CODEX_SECTION_LABELS) as CodexSection[]).map((candidate) => <button className={section === candidate ? "active" : ""} type="button" key={candidate} onClick={() => setSection(candidate)}>{CODEX_SECTION_LABELS[candidate]}</button>)}</nav> : null}

      {section === "items" && !mobileDetail ? <div className="recipe-toolbar mobile-workspace-sticky">
        <label className="recipe-search"><Search size={15} /><StableTextInput draftId="recipe-workspace-search" value={query} onValueChange={setQuery} placeholder="搜索物品、缩写或说明" aria-label="搜索配方物品" /></label>
        <div className="recipe-filters" aria-label="配方物品分类">
          {(["all", "raw", "solid", "fluid", "matrix"] as ItemFilter[]).map((option) => (
            <button className={filter === option ? "active" : ""} type="button" key={option} onClick={() => setFilter(option)}>
              {{ all: "全部", raw: "天然资源", solid: "固体", fluid: "流体", matrix: "矩阵" }[option]}
            </button>
          ))}
        </div>
        {itemPageCount > 1 ? <div className="recipe-filters" aria-label="资料库物品分页">
          <button type="button" disabled={itemPage === 0} onClick={() => setItemPage((page) => Math.max(0, page - 1))}>上一页</button>
          <button type="button" disabled={itemPage + 1 >= itemPageCount} onClick={() => setItemPage((page) => Math.min(itemPageCount - 1, page + 1))}>下一页</button>
        </div> : null}
        <span className="recipe-result-count">{visibleItems.length} 项 · {itemPage + 1}/{itemPageCount} 页</span>
      </div> : null}

      {section === "items" ? <div className="recipe-layout">
        {!mobileDetail ? <aside className="recipe-index" aria-label="物品索引">
          {pageItems.length === 0 ? <div className="recipe-index-empty">没有符合条件的物品</div> : pageItems.map((candidate) => {
            const producerCount = getProducingRecipes(candidate.id).length;
            const natural = getResourceSources(candidate.id).length > 0;
            return (
              <button className={selectedItemId === candidate.id ? "active" : ""} type="button" key={candidate.id} onClick={() => selectItem(candidate.id)}>
                <ItemGlyph itemId={candidate.id} className="item-mark" />
                <span><strong>{candidate.name}</strong><small>{natural ? "天然资源" : producerCount > 0 ? `${producerCount} 种生产方式` : "特殊来源"}</small></span>
                <em><QuantityValue value={readModel.itemStocks[candidate.id] ?? 0} interactive={false} /></em>
              </button>
            );
          })}
        </aside> : null}

        {(!mobile || mobileDetail) ? <div className="recipe-detail">
          <header className="recipe-item-header">
            <ItemMark itemId={selectedItemId} />
            <div><span>{item.kind === "matrix" ? "科研矩阵" : item.kind === "fluid" ? "流体物品" : sources.length > 0 ? "天然资源" : "工业物品"}</span><strong>{item.name}</strong><p>{item.description}</p></div>
            <div className="recipe-item-actions">
              <button type="button" disabled={readOnly} className={readModel.recipeFocus.itemId === selectedItemId ? "active" : ""} onClick={() => onFocus(readModel.recipeFocus.itemId === selectedItemId ? null : selectedItemId)} title={readOnly ? "Windows 原生模式下暂不可修改聚焦状态" : readModel.recipeFocus.itemId === selectedItemId ? "取消主界面聚焦" : "固定生产链到主界面"}><Pin size={14} /><span>{readModel.recipeFocus.itemId === selectedItemId ? "已固定" : "固定到主界面"}</span></button>
              {currentProductionLocation ? <button type="button" onClick={() => onLocateProductionLine(selectedItemId, readModel.activePlanetId)} title={`定位当前行星 ${currentProductionLocation.producerCount} 个${readModel.source === "native-core" ? "生产设备" : "生产节点及上游产线"}`}><LocateFixed size={14} /><span>定位{readModel.source === "native-core" ? "生产设备" : "产线"} · {currentProductionLocation.producerCount}</span></button> : null}
            </div>
            <dl>
              <div><dt>网络库存</dt><dd><QuantityValue value={stock} /></dd></div>
              <div><dt>生产方式</dt><dd>{producingRecipes.length + sources.length}</dd></div>
              <div><dt>下游流程</dt><dd>{consumingRecipes.length}</dd></div>
            </dl>
          </header>

          {!currentProductionLocation && productionLocations.length > 0 ? <section className="recipe-production-locations" aria-label="其他行星生产位置">
            <header><LocateFixed size={15} /><span>当前行星没有生产该物品的设备</span><strong>其他行星 {productionLocations.length}</strong></header>
            <div>{productionLocations.map((location) => <button type="button" key={location.planetId} onClick={() => onLocateProductionLine(selectedItemId, location.planetId)}><MapPin size={14} /><span>{getPlanet(location.planetId).name}</span><strong>{location.producerCount} 个生产设备</strong></button>)}</div>
          </section> : productionLocations.length === 0 ? <p className="recipe-production-empty">当前存档尚未部署该物品的生产设备。</p> : null}

          <section className="recipe-relations">
            <div><span>上游材料</span><div>{upstreamItems.length > 0 ? upstreamItems.map((id) => <ItemLink itemId={id} onSelect={selectItem} key={id} />) : <small>无合成上游</small>}</div></div>
            <ArrowRight size={16} />
            <div><span>当前物品</span><div><ItemLink itemId={selectedItemId} onSelect={selectItem} /></div></div>
            <ArrowRight size={16} />
            <div><span>下游产物</span><div>{downstreamItems.length > 0 ? downstreamItems.map((id) => <ItemLink itemId={id} onSelect={selectItem} key={id} />) : <small>无实体产物</small>}</div></div>
          </section>

          <section className="recipe-section">
            <header><Factory size={16} /><span>生产方式</span><strong>{producingRecipes.length + sources.length}</strong></header>
            <div className="recipe-method-grid">
              {sources.map((source) => (
                <article className="recipe-method recipe-method--source" key={`${source.extractorBuildingId}-${source.label}`}>
                  <header><i><Pickaxe size={15} /></i><span><strong>{source.label}</strong><button className="recipe-building-link" type="button" onClick={() => selectBuilding(source.extractorBuildingId)}>{getBuilding(source.extractorBuildingId).name}</button></span><em><MapPin size={12} />天然来源</em></header>
                  <div className="recipe-source-planets">
                    {source.planetIds.map((planetId) => <span key={planetId}><i style={{ color: getPlanet(planetId).color }}><MapPin size={13} /></i>{getPlanet(planetId).name}</span>)}
                  </div>
                  <footer><span>{source.manual ? "可手动采集或自动开采" : "必须部署采集设备"}</span><span className="recipe-unlock recipe-unlock--ready"><Check size={11} />资源来源</span></footer>
                </article>
              ))}
              {producingRecipes.map((recipe) => <RecipeFlowCard recipe={recipe} readModel={readModel} onSelect={selectItem} onSelectBuilding={selectBuilding} onSelectTechnology={selectTechnology} key={recipe.id} />)}
              {sources.length === 0 && producingRecipes.length === 0 ? <div className="recipe-section-empty">暂无已登记的生产方式</div> : null}
            </div>
          </section>

          <section className="recipe-section">
            <header><ArrowRight size={16} /><span>作为原料</span><strong>{consumingRecipes.length}</strong></header>
            <div className="recipe-method-grid">
              {consumingRecipes.map((recipe) => <RecipeFlowCard recipe={recipe} readModel={readModel} onSelect={selectItem} onSelectBuilding={selectBuilding} onSelectTechnology={selectTechnology} key={recipe.id} />)}
              {consumingRecipes.length === 0 ? <div className="recipe-section-empty">当前没有后续生产配方</div> : null}
            </div>
          </section>

          {researchUses.length > 0 ? (
            <section className="recipe-section recipe-research-uses">
              <header><FlaskConical size={16} /><span>科研用途</span><strong>{researchUses.length}</strong></header>
              <div>{researchUses.map((technology) => (
                <button type="button" key={technology.id} onClick={() => selectTechnology(technology.id)}><i>{readModel.completedTechIds.includes(technology.id) ? <Check size={12} /> : <FlaskConical size={12} />}</i><strong>{technology.name}</strong><small>消耗 <QuantityValue value={technology.costs.find((cost) => cost.itemId === selectedItemId)?.amount ?? 0} interactive={false} /></small></button>
              ))}</div>
            </section>
          ) : null}
        </div> : null}
      </div> : <CodexSections section={section} readModel={readModel} selectedBuildingId={selectedBuildingId} selectedTechId={selectedTechId} selectedPlanetId={selectedPlanetId} detailOnly={mobileDetail} onSelectBuilding={selectBuilding} onSelectTechnology={selectTechnology} onSelectPlanet={selectPlanet} onSelectItem={selectItem} />}
    </WorkspaceFrame>
  );
}
