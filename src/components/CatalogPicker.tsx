import { ArrowRight, Check, ChevronDown, Clock3, PackageOpen, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { getItem } from "../game/content";
import { getCategoryName } from "../game/contentRules";
import type { ItemDefinition, ItemId, RecipeDefinition, RecipeId } from "../game/types";
import { ItemGlyph } from "./ItemReference";
import { StableTextInput, clearStableTextDraft } from "./CompositionSafeInput";
import { AccessibleDialog } from "./AccessibleDialog";

const RECIPE_CATALOG_DRAFT_ID = "catalog-picker-recipe-search";

function CategoryFilter({ entries, value, onChange }: { entries: Array<{ categoryId?: string }>; value: string; onChange: (value: string) => void }) {
  const ids = [...new Set(entries.flatMap((entry) => entry.categoryId ? [entry.categoryId] : []))];
  return ids.length ? <label className="catalog-picker-search">分类<select aria-label="筛选内容分类" value={value} onChange={(event) => onChange(event.target.value)}><option value="">全部分类</option>{ids.map((id) => <option key={id} value={id}>{getCategoryName(id) ?? id}</option>)}</select></label> : null;
}

function usePickerInputRef() {
  return useRef<HTMLInputElement>(null);
}

function shouldAutoFocusCatalogSearch(): boolean {
  if (typeof window === "undefined") return false;
  const width = Math.max(1, Math.round(window.visualViewport?.width ?? window.innerWidth));
  const height = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight));
  return width >= 900 && !(height < 560 && width < 1100);
}

export function RecipeCatalogPicker({ value, recipes, onChange, compact = false }: {
  value: RecipeId | undefined;
  recipes: RecipeDefinition[];
  onChange: (recipeId: RecipeId) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const close = () => { setOpen(false); setQuery(""); setCategory(""); clearStableTextDraft(RECIPE_CATALOG_DRAFT_ID); };
  const inputRef = usePickerInputRef();
  const current = recipes.find((recipe) => recipe.id === value) ?? recipes[0];
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = recipes.filter((recipe) => {
    if (category && recipe.categoryId !== category) return false;
    if (!term) return true;
    const items = [...recipe.inputs, ...recipe.outputs].map((entry) => getItem(entry.itemId).name).join(" ");
    return `${recipe.name} ${items} ${getCategoryName(recipe.categoryId) ?? ""}`.toLocaleLowerCase("zh-CN").includes(term);
  });
  return (
    <>
      <button className={`catalog-picker-trigger${compact ? " catalog-picker-trigger--compact" : ""}`} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="选择当前配方">
        <span>{current?.name ?? "选择配方"}</span><ChevronDown size={13} />
      </button>
      <AccessibleDialog open={open} title="配方选择面板" layout="bare" ariaLabel="配方选择面板" className="catalog-picker" backdropClassName="catalog-picker-backdrop" initialFocusRef={shouldAutoFocusCatalogSearch() ? inputRef : undefined} onRequestClose={close}>
          <header><div><span>生产目录</span><strong>选择配方</strong></div><button type="button" onClick={close} title="关闭配方选择" aria-label="关闭配方选择"><X size={16} /></button></header>
          <label className="catalog-picker-search"><Search size={15} /><StableTextInput ref={inputRef} draftId={RECIPE_CATALOG_DRAFT_ID} value={query} onValueChange={setQuery} placeholder="搜索配方、原料或产物" aria-label="搜索配方" /></label>
          <CategoryFilter entries={recipes} value={category} onChange={setCategory} />
          <div className="recipe-catalog-grid">
            {filtered.map((recipe) => <button type="button" className={recipe.id === value ? "active" : ""} onClick={() => { onChange(recipe.id); close(); }} key={recipe.id}>
              <header>{recipe.icon ? <img src={recipe.icon} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} /> : null}<span><strong>{recipe.name}</strong><small><Clock3 size={11} />{recipe.duration}s</small></span>{recipe.id === value ? <Check size={14} /> : null}</header>
              <div><span>{recipe.inputs.length ? recipe.inputs.map((input) => <i title={`${getItem(input.itemId).name} ×${input.amount}`} key={input.itemId}><ItemGlyph itemId={input.itemId} /><b>{input.amount}</b></i>) : <em>连续</em>}</span><ArrowRight size={13} /><span>{recipe.outputs.length ? recipe.outputs.map((output) => <i title={`${getItem(output.itemId).name} ×${output.amount}`} key={output.itemId}><ItemGlyph itemId={output.itemId} /><b>{output.amount}</b></i>) : <em>流程</em>}</span></div>
            </button>)}
            {filtered.length === 0 ? <p className="catalog-picker-empty"><PackageOpen size={20} />没有匹配的配方</p> : null}
          </div>
      </AccessibleDialog>
    </>
  );
}

export function ItemCatalogPicker({ value, items, disabledIds, onChange, allowClear = false, label = "选择物品" }: {
  value?: ItemId;
  items: ItemDefinition[];
  disabledIds?: Set<ItemId>;
  onChange: (itemId: ItemId | null) => void;
  allowClear?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const itemDraftId = `catalog-picker-item-search:${label}`;
  const close = () => { setOpen(false); setQuery(""); setCategory(""); clearStableTextDraft(itemDraftId); };
  const inputRef = usePickerInputRef();
  const current = items.find((item) => item.id === value);
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = items.filter((item) => (!category || item.categoryId === category) && (!term || `${item.name} ${item.symbol} ${item.description} ${getCategoryName(item.categoryId) ?? ""}`.toLocaleLowerCase("zh-CN").includes(term)));
  return (
    <>
      <button className="catalog-picker-trigger catalog-picker-trigger--item" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label}>
        {current ? <><ItemGlyph itemId={current.id} /><span>{current.name}</span></> : <span>{label}</span>}<ChevronDown size={13} />
      </button>
      <AccessibleDialog open={open} title="物品选择面板" layout="bare" ariaLabel="物品选择面板" className="catalog-picker catalog-picker--items" backdropClassName="catalog-picker-backdrop" initialFocusRef={shouldAutoFocusCatalogSearch() ? inputRef : undefined} onRequestClose={close}>
          <header><div><span>物流目录</span><strong>{label}</strong></div><button type="button" onClick={close} title="关闭物品选择" aria-label="关闭物品选择"><X size={16} /></button></header>
          <label className="catalog-picker-search"><Search size={15} /><StableTextInput ref={inputRef} draftId={itemDraftId} value={query} onValueChange={setQuery} placeholder="搜索物品名称、符号或说明" aria-label="搜索物品" /></label>
          <CategoryFilter entries={items} value={category} onChange={setCategory} />
          <div className="item-catalog-grid">
            {allowClear ? <button type="button" className={!value ? "active" : ""} onClick={() => { onChange(null); close(); }}><i><X size={14} /></i><span><strong>未配置</strong><small>释放当前槽位</small></span></button> : null}
            {filtered.map((item) => {
              const disabled = disabledIds?.has(item.id) && item.id !== value;
              return <button type="button" disabled={disabled} className={item.id === value ? "active" : ""} onClick={() => { onChange(item.id); close(); }} key={item.id}><ItemGlyph itemId={item.id} /><span><strong>{item.name}</strong><small>{item.kind === "fluid" ? "流体" : item.kind === "matrix" ? "矩阵" : "固体"} · {item.symbol}</small></span>{item.id === value ? <Check size={13} /> : null}</button>;
            })}
            {filtered.length === 0 ? <p className="catalog-picker-empty"><PackageOpen size={20} />没有匹配的物品</p> : null}
          </div>
      </AccessibleDialog>
    </>
  );
}
