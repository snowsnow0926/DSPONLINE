import { Check, ChevronDown, ChevronUp, FlaskConical, Gauge, ListOrdered, LockKeyhole, PackageCheck, Pause, Pickaxe, Play, Rocket, Satellite, Timer, X, Zap } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { ITEMS, MATRIX_ITEM_IDS, TECHNOLOGY_LIST, getTechnology, isDeprecatedTechnology } from "../game/content";
import { INFINITE_RESEARCH_DEFINITIONS, getInfiniteResearchCompletion } from "../game/endgame";
import { getInfiniteResearchCostString, getInfiniteResearchMaximumLevel, isInfiniteResearchComplete } from "../game/infiniteResearch";
import type { InfiniteResearchId, TechnologyLayoutMode, TechId } from "../game/types";
import type { TechnologyWorkspaceReadModel } from "../game/technologyWorkspaceReadModel";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { horizontalFocusScrollLeft, useHorizontalPan } from "../hooks/useHorizontalPan";
import { getTechnologyTierGrid } from "../game/technologyTreeLayout";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import { QuantityValue } from "./QuantityValue";
import { PowerValue } from "./PowerValue";
import { WorkspaceFrame } from "./WorkspaceFrame";

interface TechnologyWorkspaceProps {
  open: boolean;
  readModel: TechnologyWorkspaceReadModel;
  /** Native authority currently exposes only append/remove queue and auto-research commands. */
  nativeAuthorityRequired?: boolean;
  onClose: () => void;
  onSelect: (techId: TechId) => void;
  onPauseResearch: () => void;
  onCancelResearch: () => void;
  onResumeResearch: () => void;
  onRemoveQueued: (techId: TechId) => void;
  onSelectInfiniteResearch: (researchId: InfiniteResearchId) => void;
  onInfiniteResearchAutomation: (enabled: boolean) => void;
  onLayoutChange: (layout: TechnologyLayoutMode) => void;
  focusTechId?: TechId | null;
  mobile?: boolean;
  mobileSubview?: string | null;
  onMobileOpenDetail?: (subview: string) => void;
}

function technologyCompleted(readModel: TechnologyWorkspaceReadModel, techId: TechId): boolean {
  return readModel.research.completedTechIds.includes(techId);
}

function technologyCanQueue(readModel: TechnologyWorkspaceReadModel, techId: TechId): boolean {
  const technology = getTechnology(techId);
  if (!technology || isDeprecatedTechnology(techId) || technologyCompleted(readModel, techId) ||
    readModel.research.selectedTechId === techId || readModel.research.queuedTechIds.includes(techId)) return false;
  const planned = new Set<TechId>([
    ...readModel.research.completedTechIds,
    ...(readModel.research.pausedTechId ? [readModel.research.pausedTechId] : []),
    ...(readModel.research.selectedTechId ? [readModel.research.selectedTechId] : []),
    ...readModel.research.queuedTechIds,
  ]);
  return technology.prerequisites.every((prerequisite) => planned.has(prerequisite));
}

function endgameUnlocked(readModel: TechnologyWorkspaceReadModel): boolean {
  return readModel.research.completedTechIds.includes("universe_matrix");
}

function infiniteResearchLevel(readModel: TechnologyWorkspaceReadModel, id: InfiniteResearchId): number {
  return Math.min(
    getInfiniteResearchMaximumLevel(id),
    Math.max(0, Math.floor(readModel.infiniteResearch[id]?.level ?? 0)),
  );
}

export function TechnologyWorkspace({ open, readModel, nativeAuthorityRequired = false, onClose, onSelect, onPauseResearch, onCancelResearch, onResumeResearch, onRemoveQueued, onSelectInfiniteResearch, onInfiniteResearchAutomation, onLayoutChange, focusTechId, mobile = false, mobileSubview, onMobileOpenDetail }: TechnologyWorkspaceProps) {
  const [focusedTechId, setFocusedTechId] = useState<TechId | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [mobileFilter, setMobileFilter] = useState<"available" | "active" | "all">("available");
  const mobileListRef = useRef<HTMLDivElement | null>(null);
  const mobileListScrollRef = useRef(0);
  const previousMobileSubviewRef = useRef<string | null>(null);
  const autoFocusedMobileSubviewRef = useRef<string | null>(null);
  const horizontalPan = useHorizontalPan<HTMLDivElement>({ wheelMode: "horizontal" });
  const [treeViewportHeight, setTreeViewportHeight] = useState(560);
  useEffect(() => {
    if (!open || !focusTechId) return;
    setFocusedTechId(focusTechId);
    const timer = window.setTimeout(() => {
      const tree = horizontalPan.surfaceRef.current;
      const node = tree?.querySelector<HTMLElement>(`[data-tech-id="${focusTechId}"]`);
      if (!tree || !node) return;
      const treeRect = tree.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      tree.scrollTo({
        left: horizontalFocusScrollLeft(
          tree.scrollLeft,
          treeRect.left,
          tree.clientWidth,
          nodeRect.left,
          nodeRect.width,
          tree.scrollWidth,
        ),
        behavior: "smooth",
      });
      tree.scrollTop = 0;
    }, 40);
    const clear = window.setTimeout(() => setFocusedTechId(null), 1800);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [focusTechId, horizontalPan.surfaceRef, open]);
  useEffect(() => {
    if (!open || mobile) return;
    const tree = horizontalPan.surfaceRef.current;
    if (!tree) return;
    const measure = () => setTreeViewportHeight((current) => {
      const next = Math.max(1, Math.floor(tree.clientHeight));
      return current === next ? current : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(tree);
    return () => observer.disconnect();
  }, [readModel.settings.fontScale, readModel.settings.technologyLayout, horizontalPan.surfaceRef, mobile, open]);
  useEffect(() => {
    if (!mobile || !open) return;
    if (previousMobileSubviewRef.current && !mobileSubview) {
      window.requestAnimationFrame(() => {
        if (mobileListRef.current) mobileListRef.current.scrollTop = mobileListScrollRef.current;
      });
    }
    previousMobileSubviewRef.current = mobileSubview ?? null;
  }, [mobile, mobileSubview, open]);
  useEffect(() => {
    if (!mobile || !open || !focusTechId || !onMobileOpenDetail) return;
    const targetSubview = `tech:${focusTechId}`;
    if (mobileSubview === targetSubview || autoFocusedMobileSubviewRef.current === targetSubview) return;
    autoFocusedMobileSubviewRef.current = targetSubview;
    if (mobileListRef.current) mobileListRef.current.scrollTop = 0;
    onMobileOpenDetail(targetSubview);
  }, [focusTechId, mobile, mobileSubview, onMobileOpenDetail, open]);
  if (!open) return null;
  const selected = getTechnology(readModel.research.selectedTechId);
  const paused = getTechnology(readModel.research.pausedTechId);
  const activeInfinite = readModel.activeInfiniteResearchId
    ? INFINITE_RESEARCH_DEFINITIONS.find((definition) => definition.id === readModel.activeInfiniteResearchId)
    : undefined;
  const activeInfiniteProgress = activeInfinite ? readModel.infiniteResearch[activeInfinite.id] : undefined;
  const displayedTechnology = selected ?? (!activeInfinite ? paused : undefined);
  const selectedProgress = displayedTechnology ? readModel.research.progressByTech[displayedTechnology.id] ?? {} : {};
  const finiteCostTotal = displayedTechnology?.costs.reduce((sum, cost) => sum + cost.amount, 0);
  const finiteProgressTotal = displayedTechnology?.costs.reduce((sum, cost) =>
    sum + Math.min(cost.amount, selectedProgress[cost.itemId] ?? 0), 0);
  const selectedCostTotal = finiteCostTotal ??
    (activeInfinite ? getInfiniteResearchCostString(activeInfinite.id, activeInfiniteProgress?.level ?? 0) : "0");
  const selectedProgressTotal = finiteProgressTotal ?? activeInfiniteProgress?.progress ?? "0";
  const selectedProgressPercent = displayedTechnology && typeof selectedCostTotal === "number" && typeof selectedProgressTotal === "number"
    ? (selectedCostTotal > 0 ? Math.min(100, selectedProgressTotal / selectedCostTotal * 100) : 0)
    : activeInfinite && activeInfiniteProgress ? getInfiniteResearchCompletion(activeInfiniteProgress, activeInfinite.id) * 100 : 0;
  const maximumTier = Math.max(...TECHNOLOGY_LIST.map((technology) => technology.tier));
  const activeCompletedCount = readModel.research.completedTechIds.filter((techId) => !isDeprecatedTechnology(techId)).length;
  const finiteQueueMutationReady = !nativeAuthorityRequired || Boolean(
    readModel.research.selectedTechId && !readModel.activeInfiniteResearchId,
  );

  if (mobile) {
    const detailTechId = mobileSubview?.startsWith("tech:") ? mobileSubview.slice(5) as TechId : null;
    const detailTechnology = getTechnology(detailTechId);
    const detailInfiniteId = mobileSubview?.startsWith("infinite:") ? mobileSubview.slice(9) as InfiniteResearchId : null;
    const detailInfinite = INFINITE_RESEARCH_DEFINITIONS.find((definition) => definition.id === detailInfiniteId);
    const unlockedEndgame = endgameUnlocked(readModel);
    const visibleTechnologies = TECHNOLOGY_LIST.filter((technology) => {
      const complete = technologyCompleted(readModel, technology.id);
      const active = readModel.research.selectedTechId === technology.id || readModel.research.pausedTechId === technology.id || readModel.research.queuedTechIds.includes(technology.id);
      if (mobileFilter === "active") return active;
      if (mobileFilter === "available") return !complete && (active || technologyCanQueue(readModel, technology.id));
      return true;
    });
    const visibleInfiniteResearch = INFINITE_RESEARCH_DEFINITIONS.filter((definition) => {
      const active = readModel.activeInfiniteResearchId === definition.id;
      const capped = isInfiniteResearchComplete(definition.id, infiniteResearchLevel(readModel, definition.id));
      if (mobileFilter === "active") return active;
      if (mobileFilter === "available") return unlockedEndgame && !capped;
      return true;
    });
    const mobileProgressPercent = selectedProgressPercent;
    return (
      <WorkspaceFrame className={`technology-workspace mobile-workspace mobile-technology${detailTechnology || detailInfinite ? " mobile-workspace--detail" : ""}`} ariaLabel="科技树" onRequestClose={onClose}>
        {detailInfinite ? <div className="mobile-workspace-scroll mobile-technology-detail mobile-infinite-research-detail">
          <header className="mobile-detail-heading"><i style={{ color: detailInfinite.color }}><Rocket size={20} /></i><span><small>白糖阶段 · 无限科技</small><strong>{detailInfinite.name}</strong></span></header>
          <p className="mobile-detail-summary">{detailInfinite.summary}</p>
          <section className="mobile-detail-section"><header>当前效果</header><div className="mobile-tech-unlocks"><span><Gauge size={15} /><strong>{detailInfinite.effect}</strong></span></div></section>
          <section className="mobile-detail-section"><header>研究状态</header><div className="mobile-tech-cost-list"><span><ItemGlyph itemId="universe_matrix" /><em>{ITEMS.universe_matrix.name}</em><strong><QuantityValue value={readModel.infiniteResearch[detailInfinite.id].progress} /> / <QuantityValue value={getInfiniteResearchCostString(detailInfinite.id, infiniteResearchLevel(readModel, detailInfinite.id))} /></strong></span></div></section>
          <section className="mobile-detail-section"><header>前置科技</header><div className="mobile-tech-prerequisites"><span className={unlockedEndgame ? "complete" : ""}>{unlockedEndgame ? <Check size={15} /> : <LockKeyhole size={15} />}<strong>完成宇宙矩阵科技</strong></span></div></section>
          <div className="mobile-detail-spacer" />
          <footer className="mobile-detail-actionbar"><button className="primary" type="button" disabled={nativeAuthorityRequired || !unlockedEndgame || isInfiniteResearchComplete(detailInfinite.id, infiniteResearchLevel(readModel, detailInfinite.id)) || readModel.activeInfiniteResearchId === detailInfinite.id} onClick={() => onSelectInfiniteResearch(detailInfinite.id)} title={nativeAuthorityRequired ? "原生权威暂未开放无限科研目标切换" : undefined}><Rocket size={18} />{nativeAuthorityRequired ? "原生只读" : !unlockedEndgame ? "需要宇宙矩阵科技" : isInfiniteResearchComplete(detailInfinite.id, infiniteResearchLevel(readModel, detailInfinite.id)) ? "已达等级上限" : readModel.activeInfiniteResearchId === detailInfinite.id ? "正在研究" : "开始无限研究"}</button></footer>
        </div> : detailTechnology ? <div className="mobile-workspace-scroll mobile-technology-detail">
          <header className="mobile-detail-heading"><i>{technologyCompleted(readModel, detailTechnology.id) ? <Check size={20} /> : <FlaskConical size={20} />}</i><span><small>科技层级 {String(detailTechnology.tier + 1).padStart(2, "0")}</small><strong>{detailTechnology.name}</strong></span></header>
          <p className="mobile-detail-summary">{detailTechnology.summary}</p>
          <section className="mobile-detail-section"><header>研究矩阵</header><div className="mobile-tech-cost-list">{detailTechnology.costs.map((cost) => { const progress = readModel.research.progressByTech[detailTechnology.id]?.[cost.itemId] ?? 0; return <span key={cost.itemId}><ItemGlyph itemId={cost.itemId} /><em>{ITEMS[cost.itemId].name}</em><strong>{progress}/{cost.amount}</strong></span>; })}</div></section>
          <section className="mobile-detail-section"><header>前置科技</header><div className="mobile-tech-prerequisites">{detailTechnology.prerequisites.length ? detailTechnology.prerequisites.map((id) => <span className={technologyCompleted(readModel, id) ? "complete" : ""} key={id}>{technologyCompleted(readModel, id) ? <Check size={15} /> : <LockKeyhole size={15} />}<strong>{getTechnology(id)?.name}</strong></span>) : <p>基础科技，无前置要求</p>}</div></section>
          <section className="mobile-detail-section"><header>解锁内容</header><div className="mobile-tech-unlocks">{detailTechnology.unlocks.map((unlock) => <span key={unlock}><PackageCheck size={15} />{unlock}</span>)}</div></section>
          <div className="mobile-detail-spacer" />
          <footer className="mobile-detail-actionbar">
            {technologyCompleted(readModel, detailTechnology.id) ? <button type="button" disabled><Check size={18} />科技已完成</button>
              : readModel.research.selectedTechId === detailTechnology.id ? <><button type="button" disabled={nativeAuthorityRequired} onClick={onPauseResearch} title={nativeAuthorityRequired ? "原生权威暂未开放暂停科研" : undefined}><Pause size={18} />暂停研究</button><button className="warning" type="button" disabled={nativeAuthorityRequired} onClick={onCancelResearch} title={nativeAuthorityRequired ? "原生权威暂未开放取消科研" : undefined}><X size={18} />取消并保留进度</button></>
                : readModel.research.pausedTechId === detailTechnology.id ? <button className="primary" type="button" disabled={nativeAuthorityRequired || Boolean(selected || activeInfinite)} onClick={onResumeResearch} title={nativeAuthorityRequired ? "原生权威暂未开放继续科研" : undefined}><Play size={18} />继续研究</button>
                  : readModel.research.queuedTechIds.includes(detailTechnology.id) ? <button className="warning" type="button" onClick={() => onRemoveQueued(detailTechnology.id)}><X size={18} />移出科研队列</button>
                    : <button className="primary" type="button" disabled={!finiteQueueMutationReady || !technologyCanQueue(readModel, detailTechnology.id)} onClick={() => onSelect(detailTechnology.id)} title={nativeAuthorityRequired && !finiteQueueMutationReady ? "原生权威当前只开放向已有有限科研追加队列" : undefined}><FlaskConical size={18} />{nativeAuthorityRequired && !finiteQueueMutationReady ? "原生只读" : readModel.research.selectedTechId || activeInfinite ? "加入科研队列" : "开始研究"}</button>}
          </footer>
        </div> : <div className="mobile-workspace-scroll" ref={mobileListRef}>
          <section className="mobile-research-status">
            <div><span>{selected || activeInfinite ? "当前研究" : paused ? "研究已暂停" : "科研空闲"}</span><strong>{displayedTechnology?.name ?? activeInfinite?.name ?? "选择一个可研究科技"}</strong><em>{Math.round(mobileProgressPercent)}%</em></div>
            <i><b style={{ width: `${mobileProgressPercent}%` }} /></i>
            <footer><span>{selectedProgressTotal} / {selectedCostTotal} 矩阵</span><strong>队列 {readModel.research.queuedTechIds.length}</strong></footer>
          </section>
          <nav className="mobile-workspace-sticky mobile-tech-filter" aria-label="科技筛选">{(["available", "active", "all"] as const).map((filter) => <button className={mobileFilter === filter ? "active" : ""} type="button" key={filter} onClick={() => setMobileFilter(filter)}>{{ available: "可研究", active: "进行中", all: "全部" }[filter]}</button>)}</nav>
          <div className="mobile-tech-list">{Array.from({ length: maximumTier + 1 }, (_, tier) => {
            const tierTechnologies = visibleTechnologies.filter((technology) => technology.tier === tier);
            if (!tierTechnologies.length) return null;
            return <section key={tier}><header>层级 {String(tier + 1).padStart(2, "0")}</header><div>{tierTechnologies.map((technology) => {
              const complete = technologyCompleted(readModel, technology.id);
              const active = readModel.research.selectedTechId === technology.id;
              const pausedTech = readModel.research.pausedTechId === technology.id;
              const queueIndex = readModel.research.queuedTechIds.indexOf(technology.id);
              const available = technologyCanQueue(readModel, technology.id);
              const progress = readModel.research.progressByTech[technology.id] ?? {};
              const done = technology.costs.reduce((sum, cost) => sum + Math.min(cost.amount, progress[cost.itemId] ?? 0), 0);
              const total = technology.costs.reduce((sum, cost) => sum + cost.amount, 0);
              return <button className={`${complete ? "complete" : ""}${active ? " active" : ""}${pausedTech ? " paused" : ""}`} type="button" key={technology.id} onClick={() => { mobileListScrollRef.current = mobileListRef.current?.scrollTop ?? 0; if (mobileListRef.current) mobileListRef.current.scrollTop = 0; onMobileOpenDetail?.(`tech:${technology.id}`); }}>
                <i>{complete ? <Check size={18} /> : active ? <Play size={18} /> : pausedTech ? <Pause size={18} /> : queueIndex >= 0 ? <ListOrdered size={18} /> : available ? <FlaskConical size={18} /> : <LockKeyhole size={18} />}</i>
                <span><strong>{technology.name}</strong><small>{technology.summary}</small>{!available && !complete && queueIndex < 0 && !pausedTech ? <em>前置：{technology.prerequisites.map((id) => getTechnology(id)?.name).join("、")}</em> : null}</span>
                <b>{pausedTech ? "暂停" : queueIndex >= 0 ? `队列 #${queueIndex + 1}` : complete ? "完成" : `${done}/${total}`}</b><ChevronDown size={17} />
              </button>;
            })}</div></section>;
          })}
          {visibleInfiniteResearch.length > 0 ? <section className="mobile-infinite-research-list"><header>白糖阶段 · 无限科技</header><div>{visibleInfiniteResearch.map((definition) => {
            const progress = readModel.infiniteResearch[definition.id];
            const level = infiniteResearchLevel(readModel, definition.id);
            const active = readModel.activeInfiniteResearchId === definition.id;
            const capped = isInfiniteResearchComplete(definition.id, level);
            return <button className={`${active ? "active" : ""}${capped ? " complete" : ""}`} type="button" key={definition.id} onClick={() => { mobileListScrollRef.current = mobileListRef.current?.scrollTop ?? 0; onMobileOpenDetail?.(`infinite:${definition.id}`); }}>
              <i style={{ color: definition.color }}>{definition.symbol}</i><span><strong>{definition.name}</strong><small>{definition.summary}</small>{!unlockedEndgame ? <em>前置：完成宇宙矩阵科技</em> : null}</span><b>{capped ? "已达上限" : active ? `${Math.round(getInfiniteResearchCompletion(progress, definition.id) * 100)}%` : `Lv.${level}`}</b><ChevronDown size={17} />
            </button>;
          })}</div></section> : null}
          {visibleTechnologies.length === 0 && visibleInfiniteResearch.length === 0 ? <div className="mobile-workspace-empty"><FlaskConical size={24} /><span>当前筛选下没有科技</span><small>{mobileFilter === "available" && !unlockedEndgame ? "无限科技前置：完成宇宙矩阵科技" : "可清除筛选查看全部普通与无限科技"}</small><button type="button" onClick={() => setMobileFilter("all")}>清除筛选</button></div> : null}</div>
        </div>}
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame className="technology-workspace" ariaLabel="科技树" onRequestClose={onClose}>
      <header className="technology-header">
        <div className="technology-title">
          <i><FlaskConical size={20} /></i>
          <div><span>星系科研协议</span><strong>科技树</strong></div>
        </div>
        <div className="technology-summary">
          {MATRIX_ITEM_IDS.map((itemId) => {
            return <span className="matrix-stock" key={itemId}><ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} /></ItemHoverCard><strong>{readModel.matrixStock[itemId as keyof typeof readModel.matrixStock]}</strong></span>;
          })}
          <span>已完成 <strong>{activeCompletedCount}/{TECHNOLOGY_LIST.length}</strong></span>
          <span>无限等级 <strong>{Object.values(readModel.infiniteResearch).reduce((sum, progress) => sum + progress.level, 0)}</strong></span>
        </div>
        <div className="technology-layout-toggle" role="group" aria-label="科技树布局">
          <button className={readModel.settings.technologyLayout === "standard" ? "active" : ""} type="button" disabled={nativeAuthorityRequired} onClick={() => onLayoutChange("standard")} title={nativeAuthorityRequired ? "原生权威暂未开放布局设置写入" : undefined}>标准</button>
          <button className={readModel.settings.technologyLayout === "compact" ? "active" : ""} type="button" disabled={nativeAuthorityRequired} onClick={() => onLayoutChange("compact")} title={nativeAuthorityRequired ? "原生权威暂未开放布局设置写入" : undefined}>精简</button>
        </div>
        <button className="technology-close" type="button" onClick={onClose} title="关闭科技树" aria-label="关闭科技树"><X size={18} /></button>
      </header>

      <div className="research-focus">
        <div>
          <span>{selected || activeInfinite ? "当前研究" : paused ? "研究已暂停" : "当前研究"}</span>
          <strong>{displayedTechnology?.name ?? activeInfinite?.name ?? "未选择科技"}</strong>
        </div>
        <div className="research-progress">
          <i><b style={{ width: `${selectedProgressPercent}%` }} /></i>
          <span>{displayedTechnology || activeInfinite ? <><QuantityValue value={selectedProgressTotal} /> / <QuantityValue value={selectedCostTotal} /> 矩阵</> : "0 / 0 矩阵"}</span>
        </div>
        <div className="research-cost-list">
          {displayedTechnology?.costs.map((cost) => {
            return <span key={cost.itemId}><ItemHoverCard itemId={cost.itemId}><ItemGlyph itemId={cost.itemId} /></ItemHoverCard>{selectedProgress[cost.itemId] ?? 0}/{cost.amount}</span>;
          })}
          {!displayedTechnology && activeInfinite ? <span><ItemHoverCard itemId="universe_matrix"><ItemGlyph itemId="universe_matrix" /></ItemHoverCard><QuantityValue value={activeInfiniteProgress?.progress ?? "0"} />/<QuantityValue value={selectedCostTotal} /></span> : null}
        </div>
        <div className="research-current-actions">
          {selected || activeInfinite ? <button type="button" disabled={nativeAuthorityRequired} onClick={onPauseResearch} title={nativeAuthorityRequired ? "原生权威暂未开放暂停科研" : "停止消耗矩阵并保留研究进度"}><Pause size={13} />暂停</button> : null}
          {selected || activeInfinite ? <button type="button" disabled={nativeAuthorityRequired} onClick={onCancelResearch} title={nativeAuthorityRequired ? "原生权威暂未开放取消科研" : "取消当前项目，已投入矩阵仍会保留"}><X size={13} />取消</button> : null}
          {!selected && !activeInfinite && paused ? <button className="confirm" type="button" disabled={nativeAuthorityRequired} onClick={onResumeResearch} title={nativeAuthorityRequired ? "原生权威暂未开放继续科研" : `从现有进度继续研究${paused.name}`}><Play size={13} />继续研究</button> : null}
        </div>
        {paused && (selected || activeInfinite) ? <div className="research-paused-summary"><Pause size={12} /><span>已暂停：<strong>{paused.name}</strong></span><button type="button" disabled title="先暂停或取消当前项目后再继续">等待当前项目</button></div> : null}
        <button className="research-advanced-toggle" type="button" onClick={() => setAdvancedExpanded((expanded) => !expanded)} title={advancedExpanded ? "收起升级与无限科研" : "展开升级与无限科研"} aria-label={advancedExpanded ? "收起科研详情" : "展开科研详情"} aria-expanded={advancedExpanded}>
          <Gauge size={14} /><span>科研详情</span>{advancedExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className="research-queue">
          <header><ListOrdered size={14} /><span>科研队列</span><strong>{readModel.research.queuedTechIds.length}</strong></header>
          <div>
            {readModel.research.queuedTechIds.length === 0 ? <span className="research-queue__empty">队列为空</span> : readModel.research.queuedTechIds.map((techId, index) => (
              <div className="research-queue__item" key={techId}>
                <b>{index + 1}</b>
                <span>{getTechnology(techId)?.name}</span>
                <button type="button" onClick={() => onRemoveQueued(techId)} title={`从科研队列移除${getTechnology(techId)?.name}`} aria-label={`从科研队列移除${getTechnology(techId)?.name}`}><X size={12} /></button>
              </div>
            ))}
          </div>
        </div>
        {advancedExpanded ? <div className="research-advanced">
          <section className="technology-upgrade-overview" aria-label="全局科技升级效果">
          <header><Gauge size={13} /><span>全局升级效果</span></header>
          <div>
            <span><Pickaxe size={13} /><small>固体采矿</small><strong>{readModel.effects.miningSpeedMultiplier.toFixed(2)}×</strong></span>
            <span><FlaskConical size={13} /><small>科研吞吐</small><strong>{readModel.effects.researchSpeedMultiplier.toFixed(2)}×</strong></span>
            <span><Rocket size={13} /><small>物流航速</small><strong>{readModel.effects.logisticsSpeedMultiplier.toFixed(2)}×</strong></span>
            <span><PackageCheck size={13} /><small>机 / 船载荷</small><strong>{readModel.effects.planetaryCargoCapacity} / {readModel.effects.interstellarCargoCapacity}</strong></span>
            <span><Timer size={13} /><small>太阳帆寿命</small><strong>{Math.round(readModel.effects.solarSailLifetimeSeconds / 60)} min</strong></span>
            <span><Satellite size={13} /><small>单站接收</small><strong><PowerValue valueKw={readModel.effects.rayReceiverCapacityKw} /></strong></span>
            <span><Zap size={13} /><small>壳面吸附</small><strong>{readModel.effects.dysonSailAbsorptionMultiplier.toFixed(2)}×</strong></span>
          </div>
          </section>
          <section className="infinite-research-console" aria-label="无限科技">
          <header><span><Rocket size={13} />无限科技</span><strong>{endgameUnlocked(readModel) ? "可持续研究" : "宇宙矩阵后解锁"}</strong><label><input type="checkbox" checked={readModel.autoResearch} disabled={!endgameUnlocked(readModel)} onChange={(event) => onInfiniteResearchAutomation(event.target.checked)} />自动续研</label></header>
          <div>
            {INFINITE_RESEARCH_DEFINITIONS.map((definition) => {
              const progress = readModel.infiniteResearch[definition.id];
              const active = readModel.activeInfiniteResearchId === definition.id;
              const level = infiniteResearchLevel(readModel, definition.id);
              const cost = getInfiniteResearchCostString(definition.id, level);
              const capped = isInfiniteResearchComplete(definition.id, level);
              return <button type="button" key={definition.id} className={active ? "active" : ""} disabled={nativeAuthorityRequired || !endgameUnlocked(readModel) || capped} onClick={() => onSelectInfiniteResearch(definition.id)} title={nativeAuthorityRequired ? "原生权威暂未开放无限科研目标切换" : active ? definition.summary : `${definition.summary} · ${formatQuantityExact(cost)} 矩阵`}>
                <i style={{ color: definition.color }}>{definition.symbol}</i><span><strong>{definition.name}</strong><small>Lv.{level}{progress.historicalLevel && progress.historicalLevel > level ? `（历史 Lv.${progress.historicalLevel}）` : ""} · {definition.effect}</small></span><em>{capped ? "已达上限" : active ? `${Math.round(getInfiniteResearchCompletion(progress, definition.id) * 100)}%` : `${formatQuantityCompact(cost)} 矩阵`}</em>
              </button>;
            })}
          </div>
          </section>
        </div> : null}
      </div>

      <div ref={horizontalPan.surfaceRef} className={`technology-tree technology-tree--${readModel.settings.technologyLayout}${horizontalPan.isPanning ? " horizontal-pan--active" : ""}`} tabIndex={0} role="region" aria-label="科技树横向视口" {...horizontalPan.bindings}>
        {Array.from({ length: maximumTier + 1 }, (_, tier) => {
          const tierTechnologies = TECHNOLOGY_LIST.filter((technology) => technology.tier === tier);
          const grid = getTechnologyTierGrid(tierTechnologies.length, readModel.settings.technologyLayout, readModel.settings.fontScale, treeViewportHeight);
          return (
          <section className="technology-tier" key={tier} style={{
            "--technology-tier-columns": grid.columns,
            "--technology-tier-rows": grid.rows,
            "--technology-tier-column-width": `${grid.columnWidth}px`,
            "--technology-node-estimated-height": `${grid.estimatedCardHeight}px`,
          } as CSSProperties} data-tier={tier + 1} data-tier-columns={grid.columns} data-tier-rows={grid.rows}>
            <header><span>层级 {String(tier + 1).padStart(2, "0")}</span></header>
            <div>
              {tierTechnologies.map((technology) => {
                const complete = technologyCompleted(readModel, technology.id);
                const active = readModel.research.selectedTechId === technology.id;
                const isPaused = readModel.research.pausedTechId === technology.id;
                const queuedIndex = readModel.research.queuedTechIds.indexOf(technology.id);
                const queued = queuedIndex >= 0;
                const available = technologyCanQueue(readModel, technology.id);
                const progress = readModel.research.progressByTech[technology.id] ?? {};
                const prerequisiteNames = technology.prerequisites.map((id) => getTechnology(id)?.name).filter(Boolean);
                return (
                  <button
                    className={`technology-node${complete ? " technology-node--complete" : ""}${active ? " technology-node--active" : ""}${isPaused ? " technology-node--paused" : ""}${queued ? " technology-node--queued" : ""}${focusedTechId === technology.id ? " technology-node--focus" : ""}`}
                    type="button"
                    key={technology.id}
                    data-tech-id={technology.id}
                    disabled={isPaused ? nativeAuthorityRequired || Boolean(selected || activeInfinite) : !finiteQueueMutationReady || !available || active || queued}
                    onClick={() => isPaused ? onResumeResearch() : onSelect(technology.id)}
                    title={nativeAuthorityRequired && (isPaused || !finiteQueueMutationReady) ? "原生权威当前只开放向已有有限科研追加队列" : isPaused ? selected || activeInfinite ? "先暂停或取消当前研究" : `继续研究：${technology.name}` : available ? readModel.research.selectedTechId ? `加入科研队列：${technology.name}` : `开始研究：${technology.name}` : undefined}
                  >
                    <header>
                      <i>{complete ? <Check size={15} /> : active ? <Play size={15} /> : isPaused ? <Pause size={15} /> : queued ? <ListOrdered size={15} /> : available ? <FlaskConical size={15} /> : <LockKeyhole size={15} />}</i>
                      <strong>{technology.name}</strong>
                      <span>{isPaused ? "已暂停" : queued ? `#${queuedIndex + 1}` : `${technology.costs.reduce((sum, cost) => sum + Math.min(cost.amount, progress[cost.itemId] ?? 0), 0)}/${technology.costs.reduce((sum, cost) => sum + cost.amount, 0)}`}</span>
                    </header>
                    <p>{technology.summary}</p>
                    <div className="technology-costs">
                      {technology.costs.map((cost) => {
                        return <span key={cost.itemId}><ItemHoverCard itemId={cost.itemId}><ItemGlyph itemId={cost.itemId} /></ItemHoverCard>{progress[cost.itemId] ?? 0}/{cost.amount}</span>;
                      })}
                    </div>
                    <div className="technology-unlocks">
                      {technology.unlocks.map((unlock) => <span key={unlock}>{unlock}</span>)}
                    </div>
                    {prerequisiteNames.length > 0 && !available && !complete && !active && !isPaused && !queued ? (
                      <small>前置：{prerequisiteNames.join("、")}</small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
          );
        })}
      </div>
    </WorkspaceFrame>
  );
}
