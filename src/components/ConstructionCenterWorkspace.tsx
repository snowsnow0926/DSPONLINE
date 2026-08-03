import { Check, Factory, Layers3, Minus, PackageOpen, Plus, Power, Search, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CONSTRUCTION, ITEMS, getConstructionDefinition, getPlanet, getRecipe, getTechnology, isConveyorBeltId } from "../game/content";
import { PORTABLE_FLEET_ITEM_IDS, getConstructionAutomationCycleSeconds, getConstructionAutomationMaterialSeconds, getConstructionAutomationStatus, getConstructionAutomationStockLimit, isPortableFleetItem, isTechnologyCompleted } from "../game/engine";
import type { ConstructionAutomationTargetId, ConstructionId, GameState, ItemId, PortableFleetItemId, TechId } from "../game/types";
import { formatQuantityCompact } from "../game/quantityFormat";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { QuantityValue } from "./QuantityValue";

type CenterCategory = "all" | "power" | "production" | "logistics" | "dyson";

const POWER_IDS = new Set<ConstructionId>(["wind_turbine", "solar_panel", "geothermal_power_station", "thermal_power_plant", "mini_fusion_power_plant", "artificial_star", "accumulator", "energy_exchanger"]);
const LOGISTICS_IDS = new Set<ConstructionId>(["conveyor_belt_mk1", "conveyor_belt_mk2", "conveyor_belt_mk3", "storage_mk1", "material_delivery_hub", "storage_tank", "splitter_4way", "planetary_logistics_station", "interstellar_logistics_station", "orbital_collector"]);
const DYSON_IDS = new Set<ConstructionId>(["em_rail_ejector", "ray_receiver", "vertical_launching_silo"]);

interface AutomationDisplayDefinition {
  id: ConstructionAutomationTargetId;
  name: string;
  outputAmount: number;
  requiredTechId?: TechId;
  costs: Array<{ itemId: ItemId; amount: number }>;
}

function automationDefinitions(): AutomationDisplayDefinition[] {
  return [
    ...CONSTRUCTION.map((definition) => ({ ...definition, id: definition.buildingId })),
    ...PORTABLE_FLEET_ITEM_IDS.flatMap((itemId) => {
      const recipe = getRecipe(itemId);
      const output = recipe?.outputs.find((candidate) => candidate.itemId === itemId);
      return recipe && output ? [{
        id: itemId,
        name: ITEMS[itemId].name,
        outputAmount: output.amount,
        requiredTechId: recipe.requiredTechId,
        costs: recipe.inputs,
      }] : [];
    }),
  ];
}

function categoryFor(id: ConstructionAutomationTargetId): Exclude<CenterCategory, "all"> {
  if (isPortableFleetItem(id)) return "logistics";
  if (POWER_IDS.has(id)) return "power";
  if (LOGISTICS_IDS.has(id)) return "logistics";
  if (DYSON_IDS.has(id)) return "dyson";
  return "production";
}

function DefinitionIcon({ id }: { id: ConstructionAutomationTargetId }) {
  if (isPortableFleetItem(id)) return <Truck size={16} />;
  if (POWER_IDS.has(id)) return <Power size={16} />;
  if (isConveyorBeltId(id)) return <Layers3 size={16} />;
  if (LOGISTICS_IDS.has(id)) return <Truck size={16} />;
  return <Factory size={16} />;
}

const TARGET_PRESETS = [0, 100, 500, 2_000, 10_000, 100_000, 100_000_000] as const;

function ConstructionTargetControl({ definition, target, stockLimit, unlocked, onChange }: {
  definition: AutomationDisplayDefinition;
  target: number;
  stockLimit: number;
  unlocked: boolean;
  onChange: (constructionId: ConstructionAutomationTargetId, target: number) => void;
}) {
  const [draft, setDraft] = useState(String(target));
  const [error, setError] = useState<string | null>(null);
  const step = Math.max(1, definition.outputAmount);
  const presets = [...new Set([...TARGET_PRESETS.filter((value) => value <= stockLimit), stockLimit])];

  useEffect(() => {
    setDraft(String(target));
    setError(null);
  }, [definition.id, target]);

  const apply = (value: number) => {
    setDraft(String(value));
    setError(null);
    onChange(definition.id, value);
  };
  const commitDraft = () => {
    const normalized = draft.trim();
    if (!/^\d+$/.test(normalized)) {
      setError("请输入 0 至当前上限的整数");
      return;
    }
    const value = Number(normalized);
    if (!Number.isSafeInteger(value)) {
      setError("目标数量超出安全整数范围");
      return;
    }
    if (value > stockLimit) {
      setError(`当前科技上限为 ${stockLimit.toLocaleString("zh-CN")}`);
      return;
    }
    apply(value);
  };

  return <div className="construction-center-target">
    <small>目标库存</small>
    <div className="construction-center-target__stepper">
      <button type="button" disabled={!unlocked || target <= 0} onClick={() => apply(Math.max(0, target - step))} aria-label={`减少${definition.name}目标库存`}><Minus size={13} /></button>
      <input inputMode="numeric" pattern="[0-9]*" min={0} max={stockLimit} step={1} value={draft} disabled={!unlocked} onChange={(event) => { setDraft(event.target.value); setError(null); }} onBlur={commitDraft} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitDraft(); } else if (event.key === "Escape") { setDraft(String(target)); setError(null); } }} aria-label={`${definition.name}目标库存`} aria-invalid={Boolean(error)} />
      <button type="button" disabled={!unlocked || target >= stockLimit} onClick={() => apply(Math.min(stockLimit, target + step))} aria-label={`增加${definition.name}目标库存`}><Plus size={13} /></button>
    </div>
    <select value={presets.includes(target) ? String(target) : ""} disabled={!unlocked} onChange={(event) => { if (event.target.value !== "") apply(Number(event.target.value)); }} aria-label={`${definition.name}常用目标库存`}>
      {!presets.includes(target) ? <option value="">自定义 {target.toLocaleString("zh-CN")}</option> : null}
      {presets.map((value) => <option value={value} key={value}>{value === 0 ? "关闭自动补足" : value === stockLimit ? `最大 ${formatQuantityCompact(value)}` : formatQuantityCompact(value)}</option>)}
    </select>
    {error ? <em role="alert">{error}</em> : null}
  </div>;
}

export function ConstructionCenterWorkspace({ open, game, onClose, onEnabledChange, onTargetChange, onBatchTargetChange }: {
  open: boolean;
  game: GameState;
  onClose: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onTargetChange: (constructionId: ConstructionAutomationTargetId, target: number) => void;
  onBatchTargetChange: (target: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CenterCategory>("all");
  const [batchDraft, setBatchDraft] = useState("");
  const [batchError, setBatchError] = useState<string | null>(null);
  const centers = game.entities.filter((entity) => entity.buildingId === "construction_center");
  const sourcePlanetId = centers[0]?.planetId ?? game.activePlanetId;
  const sourceTray = sourcePlanetId === game.activePlanetId ? game.tray : game.planetTrays[sourcePlanetId];
  const stockLimit = getConstructionAutomationStockLimit(game);
  const cycleSeconds = getConstructionAutomationCycleSeconds(game);
  const materialSeconds = getConstructionAutomationMaterialSeconds(game);
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const definitions = useMemo(() => automationDefinitions().filter((definition) => {
    if (category !== "all" && categoryFor(definition.id) !== category) return false;
    if (!term) return true;
    const materials = definition.costs.map((cost) => ITEMS[cost.itemId].name).join(" ");
    return `${definition.name} ${materials}`.toLocaleLowerCase("zh-CN").includes(term);
  }), [category, term]);
  const activeTargets = Object.values(game.constructionAutomation.targetStock).filter((target) => (target ?? 0) > 0).length;
  const completedTargets = automationDefinitions().filter((definition) => {
    const target = game.constructionAutomation.targetStock[definition.id] ?? 0;
    const current = isPortableFleetItem(definition.id) ? game.portableFleet[definition.id] ?? 0 : game.construction[definition.id] ?? 0;
    return target > 0 && current >= target;
  }).length;
  const unlockedBuildingCount = automationDefinitions().filter((definition) => !isPortableFleetItem(definition.id) && (!definition.requiredTechId || isTechnologyCompleted(game, definition.requiredTechId))).length;
  const applyBatchTarget = (target: number) => {
    if (!Number.isSafeInteger(target) || target < 1 || target > 100_000_000) {
      setBatchError("请输入 1～100,000,000 的正整数");
      return;
    }
    setBatchError(null);
    onBatchTargetChange(target);
  };
  const commitBatchDraft = () => {
    const value = batchDraft.trim();
    if (!/^\d+$/.test(value)) {
      setBatchError("请输入 1～100,000,000 的正整数");
      return;
    }
    applyBatchTarget(Number(value));
  };

  if (!open) return null;
  return (
    <section className="construction-center-workspace" role="dialog" aria-modal="true" aria-label="建筑制造中心">
      <header className="construction-center-header">
        <div><i><Factory size={20} /></i><span><small>巨构自动补给协议</small><strong>建筑制造中心</strong></span></div>
        <dl>
          <div><dt>制造中心</dt><dd>{centers.reduce((sum, entity) => sum + entity.machineCount, 0)}</dd></div>
          <div><dt>补货目标</dt><dd>{completedTargets}/{activeTargets}</dd></div>
          <div><dt>制造周期</dt><dd>{cycleSeconds}s</dd></div>
          <div><dt>材料加工</dt><dd>{materialSeconds.toFixed(2)}s/件</dd></div>
          <div><dt>库存上限</dt><dd><QuantityValue value={stockLimit} /></dd></div>
        </dl>
        <button type="button" onClick={onClose} title="关闭建筑制造中心" aria-label="关闭建筑制造中心"><X size={18} /></button>
      </header>

      <div className="construction-center-toolbar">
        <label className="construction-center-toggle"><input type="checkbox" checked={game.constructionAutomation.enabled} onChange={(event) => onEnabledChange(event.target.checked)} /><i /><span><strong>自动补足</strong><small>{game.constructionAutomation.enabled ? "制造协议运行" : "制造协议暂停"}</small></span></label>
        <label className="construction-center-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索建筑或材料" aria-label="搜索自动制造建筑" /></label>
        <div className="construction-center-categories" role="group" aria-label="建筑制造分类">
          {(["all", "power", "production", "logistics", "dyson"] as CenterCategory[]).map((id) => <button className={category === id ? "active" : ""} type="button" key={id} onClick={() => setCategory(id)}>{{ all: "全部", power: "能源", production: "生产", logistics: "物流", dyson: "戴森" }[id]}</button>)}
        </div>
      </div>

      <section className="construction-center-batch-target" aria-label="批量设置建筑制造目标">
        <div><strong>全部建筑目标</strong><small>一次修改 {unlockedBuildingCount} 种已解锁可制造建筑，不会生成建筑或取消现有任务</small></div>
        <div className="construction-center-batch-target__actions">
          {[100, 1_000, 10_000].map((value) => <button type="button" key={value} onClick={() => applyBatchTarget(value)}>{formatQuantityCompact(value)}</button>)}
          <input inputMode="numeric" pattern="[0-9]*" value={batchDraft} onChange={(event) => { setBatchDraft(event.target.value); setBatchError(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitBatchDraft(); } }} placeholder="自定义" aria-label="全部建筑目标数量" />
          <button type="button" className="primary" onClick={commitBatchDraft}>应用全部</button>
        </div>
        {batchError ? <em role="alert">{batchError}</em> : null}
      </section>

      <div className="construction-center-status">
        <span><PackageOpen size={14} />取料行星 <strong>{getPlanet(sourcePlanetId).name}</strong></span>
        <span>累计制造 <strong><QuantityValue value={game.constructionAutomation.totalCrafted} /></strong></span>
        <span>最近完成 <strong>{game.constructionAutomation.lastCraftedId ? isPortableFleetItem(game.constructionAutomation.lastCraftedId) ? ITEMS[game.constructionAutomation.lastCraftedId].name : getConstructionDefinition(game.constructionAutomation.lastCraftedId)?.name ?? "未知" : "尚无"}</strong></span>
        {centers.map((center) => {
          const status = getConstructionAutomationStatus(game, center.id);
          const wipDetail = status.wipItems?.map((item) => `${ITEMS[item.itemId].name} ${formatQuantityCompact(item.amount)}`).join("、");
          const destroyedDetail = status.destroyedByproductItems?.map((item) => `${ITEMS[item.itemId].name} ${formatQuantityCompact(item.amount)}`).join("、");
          return <span key={center.id}>{getPlanet(center.planetId).name} <strong>{status.stage}</strong>{` · WIP ${formatQuantityCompact(status.wipCount ?? 0)}${wipDetail ? `（${wipDetail}）` : ""} · 已销毁副产物 ${formatQuantityCompact(status.destroyedByproductCount ?? 0)}${destroyedDetail ? `（${destroyedDetail}）` : ""}`}{status.missingItemId ? ` · 缺${ITEMS[status.missingItemId].name} ${formatQuantityCompact(status.missingAmount ?? 1)}` : status.etaSeconds > 0 ? ` · ${status.etaSeconds.toFixed(1)}s` : ""}{status.recipeFallbackReason ? ` · 已回退：${status.recipeFallbackReason}` : ""}</span>;
        })}
        {centers.length === 0 ? <em>需要先在画布放置建筑制造中心</em> : null}
      </div>

      <div className="construction-center-list">
        {definitions.map((definition) => {
          const current = Math.floor(isPortableFleetItem(definition.id) ? game.portableFleet[definition.id] ?? 0 : game.construction[definition.id] ?? 0);
          const target = Math.floor(game.constructionAutomation.targetStock[definition.id] ?? 0);
          const unlocked = !definition.requiredTechId || isTechnologyCompleted(game, definition.requiredTechId);
          const complete = target > 0 && current >= target;
          const missing = definition.costs.filter((cost) => (sourceTray[cost.itemId] ?? 0) < cost.amount);
          return <article className={`${target > 0 ? "construction-center-row construction-center-row--targeted" : "construction-center-row"}${complete ? " construction-center-row--complete" : ""}`} key={definition.id}>
            <i><DefinitionIcon id={definition.id} /></i>
            <div className="construction-center-identity"><strong>{definition.name}</strong><small>{unlocked ? <>每批 ×<QuantityValue value={definition.outputAmount} /></> : `需要科技：${getTechnology(definition.requiredTechId)?.name ?? "未解锁"}`}</small></div>
            <div className="construction-center-materials">
              {definition.costs.map((cost) => <ItemHoverCard itemId={cost.itemId} key={cost.itemId}><span className={(sourceTray[cost.itemId] ?? 0) >= cost.amount ? "ready" : "missing"}><ItemGlyph itemId={cost.itemId} /><b><QuantityValue value={cost.amount} /></b></span></ItemHoverCard>)}
            </div>
            <div className="construction-center-stock"><small>{isPortableFleetItem(definition.id) ? "随身载具" : "施工库存"}</small><strong><QuantityValue value={current} /></strong>{target > 0 ? <span className={complete ? "ready" : missing.length > 0 ? "missing" : "working"}>{complete ? <Check size={12} /> : null}{complete ? "已补足" : missing.length > 0 ? `递归检查 ${ITEMS[missing[0].itemId].name}` : "补货中"}</span> : <span>未设目标</span>}</div>
            <ConstructionTargetControl definition={definition} target={target} stockLimit={stockLimit} unlocked={unlocked} onChange={onTargetChange} />
          </article>;
        })}
        {definitions.length === 0 ? <div className="construction-center-empty"><Search size={22} /><strong>没有符合条件的建筑</strong></div> : null}
      </div>
    </section>
  );
}
