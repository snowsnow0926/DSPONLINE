import { ArrowDown, ArrowUp, BookOpen, ChevronDown, ChevronRight, Factory, Pin, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ITEMS, getBuilding, getItem } from "../game/content";
import { getConsumingRecipes, getProducingRecipes, getResourceSources } from "../game/recipeGraph";
import type { RecipeFocusReadModel } from "../game/recipeFocusReadModel";
import type { ItemId, RecipeDefinition, RecipeFocusMode } from "../game/types";
import { ItemGlyph } from "./ItemReference";

function ItemBadge({ itemId, onOpen }: { itemId: ItemId; onOpen: (itemId: ItemId) => void }) {
  return <button className="recipe-focus-item" type="button" onClick={() => onOpen(itemId)} title={`打开${getItem(itemId).name}图鉴`}><ItemGlyph itemId={itemId} /><span>{getItem(itemId).name}</span></button>;
}

function recipeFor(itemId: ItemId, direction: "up" | "down"): RecipeDefinition[] {
  return direction === "up" ? getProducingRecipes(itemId).slice(0, 3) : getConsumingRecipes(itemId).slice(0, 3);
}

function directItems(itemId: ItemId, direction: "up" | "down"): ItemId[] {
  const recipes = recipeFor(itemId, direction);
  return [...new Set(recipes.flatMap((recipe) => direction === "up"
    ? recipe.inputs.map((input) => input.itemId)
    : recipe.outputs.map((output) => output.itemId)))].slice(0, 8);
}

function ChainBranch({ itemId, direction, depth, maxDepth, path, onOpen }: {
  itemId: ItemId;
  direction: "up" | "down";
  depth: number;
  maxDepth: number;
  path: Set<ItemId>;
  onOpen: (itemId: ItemId) => void;
}) {
  const sources = getResourceSources(itemId);
  const recipes = recipeFor(itemId, direction);
  const nextPath = new Set(path).add(itemId);
  if (depth >= maxDepth || (recipes.length === 0 && sources.length === 0)) return null;
  return (
    <div className={`recipe-focus-branch recipe-focus-branch--${direction}`}>
      {sources.length > 0 ? <div className="recipe-focus-source"><Pin size={11} /><span>天然来源 · {sources.map((source) => source.label).join(" / ")}</span></div> : null}
      {recipes.map((recipe) => {
        const linkedItems = direction === "up" ? recipe.inputs.map((input) => input.itemId) : recipe.outputs.map((output) => output.itemId);
        return (
          <div className="recipe-focus-step" key={`${direction}-${recipe.id}`}>
            <div className="recipe-focus-step-head"><Factory size={12} /><span>{recipe.name}</span><small>{getBuilding(recipe.buildingId).shortName} · {recipe.duration}s</small></div>
            <div className="recipe-focus-step-items">
              {linkedItems.map((nextItemId) => <div key={nextItemId} className="recipe-focus-child"><ItemBadge itemId={nextItemId} onOpen={onOpen} />{!nextPath.has(nextItemId) ? <ChainBranch itemId={nextItemId} direction={direction} depth={depth + 1} maxDepth={maxDepth} path={nextPath} onOpen={onOpen} /> : <span className="recipe-focus-cycle">循环</span>}</div>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompactLane({ itemId, direction, onOpen }: { itemId: ItemId; direction: "up" | "down"; onOpen: (itemId: ItemId) => void }) {
  const items = directItems(itemId, direction);
  const sources = direction === "up" ? getResourceSources(itemId) : [];
  return (
    <section className={`recipe-focus-lane recipe-focus-lane--${direction}`}>
      <header>{direction === "up" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}<span>{direction === "up" ? "上游" : "下游"}</span><small>{items.length + sources.length}</small></header>
      <div className="recipe-focus-lane-items">
        {sources.length > 0 ? <span className="recipe-focus-source-chip"><Pin size={10} />矿脉</span> : null}
        {items.length > 0 ? items.map((nextItemId) => <ItemBadge itemId={nextItemId} onOpen={onOpen} key={nextItemId} />) : <span className="recipe-focus-empty">无直接流程</span>}
      </div>
    </section>
  );
}

export function RecipeFocusPanel({ model, onClear, onModeChange, onOpen, onPositionChange }: {
  model: RecipeFocusReadModel | null;
  onClear: () => void;
  onModeChange: (mode: RecipeFocusMode) => void;
  onOpen: (itemId?: ItemId) => void;
  onPositionChange: (position: { x: number; y: number }) => void;
}) {
  const itemId = model?.itemId ?? null;
  const [position, setPosition] = useState(model?.position ?? { x: 24, y: 72 });
  const positionRef = useRef(position);
  const dragRef = useRef<{ offsetX: number; offsetY: number; parent: DOMRect } | null>(null);
  useEffect(() => {
    if (!model) return;
    setPosition(model.position);
    positionRef.current = model.position;
  }, [model?.position.x, model?.position.y]);
  if (!model || !itemId || !ITEMS[itemId]) return null;
  const maxDepth = model.mode === "full" ? 8 : 2;
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const panel = event.currentTarget.closest(".recipe-focus-panel") as HTMLElement | null;
    const parent = panel?.parentElement;
    if (!panel || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const panelRect = panel.getBoundingClientRect();
    dragRef.current = { offsetX: event.clientX - panelRect.left, offsetY: event.clientY - panelRect.top, parent: parent.getBoundingClientRect() };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const panel = event.currentTarget.closest(".recipe-focus-panel") as HTMLElement | null;
    if (!drag || !panel) return;
    const x = Math.max(8, Math.min(drag.parent.width - panel.offsetWidth - 8, event.clientX - drag.parent.left - drag.offsetX));
    const y = Math.max(8, Math.min(drag.parent.height - panel.offsetHeight - 8, event.clientY - drag.parent.top - drag.offsetY));
    const next = { x: Math.round(x), y: Math.round(y) };
    positionRef.current = next;
    setPosition(next);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onPositionChange(positionRef.current);
  };
  return (
    <aside className="recipe-focus-panel nodrag nopan" style={{ left: position.x, top: position.y, right: "auto", bottom: "auto" }} aria-label="当前聚焦生产链" data-recipe-focus-source={model.source}>
      <header className="recipe-focus-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <div><i><BookOpen size={14} /></i><span><small>聚焦材料 · 可拖动</small><strong>{getItem(itemId).name}</strong></span></div>
        <div className="recipe-focus-actions"><div className="recipe-focus-mode" role="group" aria-label="生产链展开层级"><button type="button" className={model.mode === "two-level" ? "active" : ""} onClick={() => onModeChange("two-level")}><ChevronRight size={12} />两层</button><button type="button" className={model.mode === "full" ? "active" : ""} onClick={() => onModeChange("full")}><ChevronDown size={12} />完整</button></div><button type="button" onClick={() => onOpen(itemId)} title="打开生产资料库" aria-label="打开生产资料库"><BookOpen size={14} /></button><button type="button" onClick={onClear} title="取消聚焦材料" aria-label="取消聚焦材料"><X size={14} /></button></div>
      </header>
      <div className="recipe-focus-strip"><CompactLane itemId={itemId} direction="up" onOpen={onOpen} /><section className="recipe-focus-center"><ItemBadge itemId={itemId} onOpen={onOpen} /><small>{getProducingRecipes(itemId).length + getResourceSources(itemId).length} 种来源</small></section><CompactLane itemId={itemId} direction="down" onOpen={onOpen} /></div>
      {model.mode === "full" ? <div className="recipe-focus-details"><section><header><ArrowUp size={12} /><span>完整上游链</span></header><ChainBranch itemId={itemId} direction="up" depth={0} maxDepth={maxDepth} path={new Set()} onOpen={onOpen} /></section><section><header><ArrowDown size={12} /><span>完整下游链</span></header><ChainBranch itemId={itemId} direction="down" depth={0} maxDepth={maxDepth} path={new Set()} onOpen={onOpen} /></section></div> : null}
    </aside>
  );
}
