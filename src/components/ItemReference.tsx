import { BookOpen, Crosshair, Factory, FlaskConical, MapPin } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getCompatibleRecipeBuildings, getItem, getPlanet } from "../game/content";
import { getConsumingRecipes, getProducingRecipes, getResearchUses, getResourceSources } from "../game/recipeGraph";
import type { ItemId } from "../game/types";

interface TooltipAnchor {
  left: number;
  top?: number;
  bottom?: number;
}

const KIND_LABELS = {
  solid: "固体物品",
  fluid: "流体物品",
  matrix: "科研矩阵",
} as const;

export interface ItemReferenceActions {
  getLocateAvailability: (itemId: ItemId) => { available: boolean; reason?: string };
  onLocate: (itemId: ItemId) => void;
  onOpenCodex: (itemId: ItemId) => void;
}

const ItemReferenceActionsContext = createContext<ItemReferenceActions | null>(null);

export function ItemReferenceActionsProvider({ actions, children }: { actions: ItemReferenceActions; children: ReactNode }) {
  return <ItemReferenceActionsContext.Provider value={actions}>{children}</ItemReferenceActionsContext.Provider>;
}

export function ItemGlyph({ itemId, className = "" }: { itemId: ItemId; className?: string }) {
  const item = getItem(itemId);
  return <i className={`item-glyph item-glyph--${item.kind}${className ? ` ${className}` : ""}`} style={{ backgroundColor: item.color }}>{item.symbol}</i>;
}

export function ItemHoverCard({ itemId, children, className = "" }: {
  itemId: ItemId;
  children: ReactNode;
  className?: string;
}) {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const actions = useContext(ItemReferenceActionsContext);
  const closeTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const item = getItem(itemId);
  const details = useMemo(() => ({
    producers: getProducingRecipes(itemId),
    consumers: getConsumingRecipes(itemId),
    research: getResearchUses(itemId),
    sources: getResourceSources(itemId),
  }), [itemId]);

  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [anchor]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setAnchor(null), 220);
  };

  const open = (element: HTMLElement) => {
    cancelClose();
    const bounds = element.getBoundingClientRect();
    const width = Math.min(286, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left + bounds.width / 2 - width / 2));
    const below = bounds.bottom < window.innerHeight * 0.58;
    setAnchor(below
      ? { left, top: bounds.bottom + 8 }
      : { left, bottom: window.innerHeight - bounds.top + 8 });
  };

  const primaryRecipe = details.producers[0];
  const primaryInputs = primaryRecipe?.inputs.map((input) => `${getItem(input.itemId).name} ×${input.amount}`).join(" + ");
  const primaryEquipment = primaryRecipe
    ? getCompatibleRecipeBuildings(primaryRecipe).map((building) => building.shortName).join(" / ")
    : "";
  // Production-line lookup walks the factory graph. Keep it out of the normal
  // render path; only an opened card needs to know whether its action is enabled.
  const locateAvailability = anchor && actions
    ? actions.getLocateAvailability(itemId)
    : { available: false, reason: "打开卡片后检查生产来源" };
  return (
    <span
      className={`item-reference${className ? ` ${className}` : ""}`}
      aria-haspopup="dialog"
      onMouseEnter={(event) => open(event.currentTarget)}
      onMouseLeave={scheduleClose}
      onFocus={(event) => open(event.currentTarget)}
      onBlur={scheduleClose}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
        if (window.matchMedia?.("(pointer: coarse)").matches) open(event.currentTarget);
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" || event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
        if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
        const element = event.currentTarget;
        longPressTimerRef.current = window.setTimeout(() => open(element), 420);
      }}
      onPointerUp={() => {
        if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }}
      onPointerCancel={() => {
        if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }}
    >
      {children}
      {anchor ? createPortal(
        <aside
          className="item-hover-card"
          role="dialog"
          aria-label={`${item.name}快捷操作`}
          style={anchor}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onFocus={cancelClose}
          onClick={(event) => event.stopPropagation()}
        >
          <header>
            <ItemGlyph itemId={itemId} />
            <span><strong>{item.name}</strong><small>{KIND_LABELS[item.kind]}</small></span>
          </header>
          <p>{item.description}</p>
          {details.sources.length > 0 ? (
            <div className="item-hover-line">
              <MapPin size={13} />
              <span><b>来源</b>{details.sources[0].label} · {details.sources[0].planetIds.map((id) => getPlanet(id).name).join(" / ")}{details.sources.length > 1 ? ` · 另 ${details.sources.length - 1} 种` : ""}</span>
            </div>
          ) : null}
          {primaryRecipe ? (
            <div className="item-hover-line">
              <Factory size={13} />
              <span><b>配方</b>{primaryInputs || "无需物料"} · {primaryEquipment} {primaryRecipe.duration}s{details.producers.length > 1 ? ` · 另 ${details.producers.length - 1} 种` : ""}</span>
            </div>
          ) : null}
          {details.consumers.length > 0 || details.research.length > 0 ? (
            <div className="item-hover-line">
              <FlaskConical size={13} />
              <span><b>用途</b>{details.consumers.length} 项生产配方{details.research.length > 0 ? ` · ${details.research.length} 项科技` : ""}</span>
            </div>
          ) : null}
          {details.sources.length === 0 && !primaryRecipe ? <div className="item-hover-empty">暂无已登记的生产来源</div> : null}
          <footer className="item-hover-actions">
            <button
              type="button"
              disabled={!locateAvailability.available}
              title={locateAvailability.available ? `定位${item.name}生产线` : locateAvailability.reason ?? "当前存档没有生产来源"}
              aria-label={locateAvailability.available ? `定位${item.name}生产线` : `${item.name}没有可定位的生产来源`}
              onClick={() => { actions?.onLocate(itemId); setAnchor(null); }}
            ><Crosshair size={15} /><span>定位</span></button>
            <button
              type="button"
              disabled={!actions}
              title={`打开${item.name}图鉴`}
              aria-label={`打开${item.name}图鉴`}
              onClick={() => { actions?.onOpenCodex(itemId); setAnchor(null); }}
            ><BookOpen size={15} /><span>打开图鉴</span></button>
          </footer>
        </aside>,
        document.body,
      ) : null}
    </span>
  );
}
