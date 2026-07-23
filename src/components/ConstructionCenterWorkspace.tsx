import { Check, Factory, Layers3, Minus, PackageOpen, Plus, Power, Search, Truck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { CONSTRUCTION, ITEMS, getConstructionDefinition, getPlanet, getTechnology, isConveyorBeltId } from "../game/content";
import { getConstructionAutomationCycleSeconds, getConstructionAutomationMaterialSeconds, getConstructionAutomationStatus, getConstructionAutomationStockLimit, isTechnologyCompleted } from "../game/engine";
import type { ConstructionId, GameState, ItemId } from "../game/types";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";

type CenterCategory = "all" | "power" | "production" | "logistics" | "dyson";

const POWER_IDS = new Set<ConstructionId>(["wind_turbine", "solar_panel", "geothermal_power_station", "thermal_power_plant", "mini_fusion_power_plant", "artificial_star", "accumulator", "energy_exchanger"]);
const LOGISTICS_IDS = new Set<ConstructionId>(["conveyor_belt_mk1", "conveyor_belt_mk2", "conveyor_belt_mk3", "storage_mk1", "material_delivery_hub", "storage_tank", "splitter_4way", "planetary_logistics_station", "interstellar_logistics_station", "orbital_collector"]);
const DYSON_IDS = new Set<ConstructionId>(["em_rail_ejector", "ray_receiver", "vertical_launching_silo"]);

function categoryFor(id: ConstructionId): Exclude<CenterCategory, "all"> {
  if (POWER_IDS.has(id)) return "power";
  if (LOGISTICS_IDS.has(id)) return "logistics";
  if (DYSON_IDS.has(id)) return "dyson";
  return "production";
}

function DefinitionIcon({ id }: { id: ConstructionId }) {
  if (POWER_IDS.has(id)) return <Power size={16} />;
  if (isConveyorBeltId(id)) return <Layers3 size={16} />;
  if (LOGISTICS_IDS.has(id)) return <Truck size={16} />;
  return <Factory size={16} />;
}

export function ConstructionCenterWorkspace({ open, game, onClose, onEnabledChange, onTargetChange }: {
  open: boolean;
  game: GameState;
  onClose: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onTargetChange: (constructionId: ConstructionId, target: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CenterCategory>("all");
  const centers = game.entities.filter((entity) => entity.buildingId === "construction_center");
  const sourcePlanetId = centers[0]?.planetId ?? game.activePlanetId;
  const sourceTray = sourcePlanetId === game.activePlanetId ? game.tray : game.planetTrays[sourcePlanetId];
  const stockLimit = getConstructionAutomationStockLimit(game);
  const cycleSeconds = getConstructionAutomationCycleSeconds(game);
  const materialSeconds = getConstructionAutomationMaterialSeconds(game);
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const definitions = useMemo(() => CONSTRUCTION.filter((definition) => {
    if (category !== "all" && categoryFor(definition.buildingId) !== category) return false;
    if (!term) return true;
    const materials = definition.costs.map((cost) => ITEMS[cost.itemId].name).join(" ");
    return `${definition.name} ${materials}`.toLocaleLowerCase("zh-CN").includes(term);
  }), [category, term]);
  const activeTargets = Object.values(game.constructionAutomation.targetStock).filter((target) => (target ?? 0) > 0).length;
  const completedTargets = CONSTRUCTION.filter((definition) => {
    const target = game.constructionAutomation.targetStock[definition.buildingId] ?? 0;
    return target > 0 && (game.construction[definition.buildingId] ?? 0) >= target;
  }).length;

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
          <div><dt>库存上限</dt><dd>{stockLimit}</dd></div>
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

      <div className="construction-center-status">
        <span><PackageOpen size={14} />取料行星 <strong>{getPlanet(sourcePlanetId).name}</strong></span>
        <span>累计制造 <strong>{game.constructionAutomation.totalCrafted.toLocaleString("zh-CN")}</strong></span>
        <span>最近完成 <strong>{game.constructionAutomation.lastCraftedId ? getConstructionDefinition(game.constructionAutomation.lastCraftedId)?.name ?? "未知" : "尚无"}</strong></span>
        {centers.map((center) => {
          const status = getConstructionAutomationStatus(game, center.id);
          return <span key={center.id}>{getPlanet(center.planetId).name} <strong>{status.stage}</strong>{status.missingItemId ? ` · 缺${ITEMS[status.missingItemId].name} ${status.missingAmount ?? 1}` : status.etaSeconds > 0 ? ` · ${status.etaSeconds.toFixed(1)}s` : ""}</span>;
        })}
        {centers.length === 0 ? <em>需要先在画布放置建筑制造中心</em> : null}
      </div>

      <div className="construction-center-list">
        {definitions.map((definition) => {
          const current = Math.floor(game.construction[definition.buildingId] ?? 0);
          const target = Math.floor(game.constructionAutomation.targetStock[definition.buildingId] ?? 0);
          const unlocked = !definition.requiredTechId || isTechnologyCompleted(game, definition.requiredTechId);
          const complete = target > 0 && current >= target;
          const missing = definition.costs.filter((cost) => (sourceTray[cost.itemId] ?? 0) < cost.amount);
          return <article className={`${target > 0 ? "construction-center-row construction-center-row--targeted" : "construction-center-row"}${complete ? " construction-center-row--complete" : ""}`} key={definition.buildingId}>
            <i><DefinitionIcon id={definition.buildingId} /></i>
            <div className="construction-center-identity"><strong>{definition.name}</strong><small>{unlocked ? `每批 ×${definition.outputAmount}` : `需要科技：${getTechnology(definition.requiredTechId)?.name ?? "未解锁"}`}</small></div>
            <div className="construction-center-materials">
              {definition.costs.map((cost) => <ItemHoverCard itemId={cost.itemId} key={cost.itemId}><span className={(sourceTray[cost.itemId] ?? 0) >= cost.amount ? "ready" : "missing"}><ItemGlyph itemId={cost.itemId} /><b>{cost.amount}</b></span></ItemHoverCard>)}
            </div>
            <div className="construction-center-stock"><small>施工库存</small><strong>{current}</strong>{target > 0 ? <span className={complete ? "ready" : missing.length > 0 ? "missing" : "working"}>{complete ? <Check size={12} /> : null}{complete ? "已补足" : missing.length > 0 ? `缺 ${ITEMS[missing[0].itemId].name}` : "补货中"}</span> : <span>未设目标</span>}</div>
            <div className="construction-center-target">
              <small>目标库存</small>
              <div><button type="button" disabled={!unlocked || target <= 0} onClick={() => onTargetChange(definition.buildingId, Math.max(0, target - Math.max(1, definition.outputAmount)))} aria-label={`减少${definition.name}目标库存`}><Minus size={13} /></button><input type="number" min={0} max={stockLimit} step={definition.outputAmount} value={target} disabled={!unlocked} onChange={(event) => onTargetChange(definition.buildingId, Number(event.target.value))} aria-label={`${definition.name}目标库存`} /><button type="button" disabled={!unlocked || target >= stockLimit} onClick={() => onTargetChange(definition.buildingId, Math.min(stockLimit, target + Math.max(1, definition.outputAmount)))} aria-label={`增加${definition.name}目标库存`}><Plus size={13} /></button></div>
            </div>
          </article>;
        })}
        {definitions.length === 0 ? <div className="construction-center-empty"><Search size={22} /><strong>没有符合条件的建筑</strong></div> : null}
      </div>
    </section>
  );
}
