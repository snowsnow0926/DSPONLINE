import {
  ArrowDownUp,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Factory,
  Focus,
  Hammer,
  LayoutTemplate,
  Lock,
  Minus,
  Orbit,
  PackageOpen,
  Pin,
  Plus,
  Route,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Unlock,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CONSTRUCTION,
  ITEMS,
  getBeltConstructionId,
  getBeltTier,
  getBuilding,
  getConstructionDefinition,
  getExtractorBuildingId,
  getItem,
  getPlanet,
  getRecipe,
  getTechnology,
  isConveyorBeltId,
} from "../../game/content";
import {
  MAX_BELT_LANES,
  PORTABLE_FLEET_ITEM_IDS,
  canPlaceBuildingOnPlanet,
  canUpgradeBelt,
  canUpgradeEntity,
  getBeltCapacity,
  getBeltLaneAdjustmentCheck,
  getConstructionQuickCraftPlan,
  getDysonEngineeringSnapshot,
  getEjectorOrbitTargetStatus,
  getEffectiveSimulationMultiplier,
  getEntityCycleRatePerSimulationSecond,
  getEntityOperatingStatus,
  getEntityPowerFactor,
  getOrbitalCollectorQuantumStatus,
  getQuantumAttachmentStatus,
  getMaterialDeliverySlots,
  getRecursiveHandcraftPlan,
  getResourceReserveSnapshot,
  isTechnologyCompleted,
} from "../../game/engine";
import type { PlanetTrayDiscardRequest } from "../../game/engine";
import { TrayManagementDialog } from "../TrayManagementDialog";
import type {
  BeltConnection,
  BeltTier,
  BuildingId,
  ConstructionId,
  ConveyorBeltId,
  FactoryEntity,
  GameState,
  ItemId,
  MaterialDeliverySlotMode,
  PlacementCount,
  PortableFleetItemId,
  RecipeId,
} from "../../game/types";
import type { MobileSheetSnap } from "../../hooks/useMobileNavigation";
import { PowerValue } from "../PowerValue";
import { ItemCatalogPicker } from "../CatalogPicker";
import { CONSTRUCTION_BUILD_ORDER, constructionBuildIcon } from "../GamePanels";
import { ItemGlyph } from "../ItemReference";
import { QuantityStepper } from "../QuantityStepper";
import { QuantityValue } from "../QuantityValue";
import { formatQuantityCompact } from "../../game/quantityFormat";
import { getInterstellarStationUpgradeStatus } from "../../game/systemSpaceStation";
import { MobileSheetFrame } from "./MobileSheetFrame";
import { useWorkDisplayProgress } from "../../hooks/useProductionVisualClock";
import type { WorkProgressMode } from "../../game/productionRefresh";

export type MobileCanvasMode = "browse" | "place" | "connect" | "select" | "layout" | "region";

type BuildMode = "deploy" | "craft" | "fleet";
type BuildCategory = "all" | "recent" | "power" | "production" | "logistics" | "dyson";

const BUILD_CATEGORIES: Record<Exclude<BuildCategory, "all" | "recent">, Set<ConstructionId>> = {
  power: new Set(["wind_turbine", "solar_panel", "geothermal_power_station", "thermal_power_plant", "mini_fusion_power_plant", "artificial_star", "accumulator", "energy_exchanger"]),
  production: new Set(["mining_machine", "arc_smelter", "plane_smelter", "assembling_machine_mk1", "assembling_machine_mk2", "assembling_machine_mk3", "matrix_lab", "oil_extractor", "oil_refinery", "water_pump", "chemical_plant", "quantum_chemical_plant", "fractionator", "miniature_particle_collider", "spray_coater", "construction_center"]),
  logistics: new Set(["conveyor_belt_mk1", "conveyor_belt_mk2", "conveyor_belt_mk3", "storage_mk1", "material_delivery_hub", "splitter_4way", "storage_tank", "planetary_logistics_station", "interstellar_logistics_station", "space_station_construction_launcher", "orbital_collector"]),
  dyson: new Set(["em_rail_ejector", "vertical_launching_silo", "ray_receiver", "galactic_material_exporter", "micro_black_hole_connector", "time_warp_device"]),
};

const BUILD_MODE_LABELS: Record<BuildMode, string> = { deploy: "部署", craft: "制造", fleet: "载具" };
const BUILD_CATEGORY_LABELS: Record<BuildCategory, string> = { all: "全部", recent: "最近", power: "能源", production: "生产", logistics: "物流", dyson: "戴森" };
const PLACEMENT_COUNTS: PlacementCount[] = [1, 2, 5, 10];
const MOBILE_RECENT_BUILD_KEY = "dsp-idle-network.mobile-recent-construction.v1";

function loadMobileRecentBuilds(): Array<BuildingId | ConveyorBeltId> {
  try {
    const value = JSON.parse(window.localStorage.getItem(MOBILE_RECENT_BUILD_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is BuildingId | ConveyorBeltId => typeof id === "string" && CONSTRUCTION_BUILD_ORDER.includes(id as BuildingId | ConveyorBeltId)).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function constructionLabel(id: ConstructionId): string {
  if (isConveyorBeltId(id)) {
    const tier = getBeltTier(id);
    return `传送带 Mk.${tier === 3 ? "III" : tier === 2 ? "II" : tier === 1 ? "I" : tier}`;
  }
  return getBuilding(id as BuildingId).name;
}

function isConstructionVisible(game: GameState, id: ConstructionId): boolean {
  if ((game.construction[id] ?? 0) > 0) return true;
  if (isConveyorBeltId(id) && game.belts.some((belt) => belt.tier === getBeltTier(id))) return true;
  if (id === "mining_machine" && game.entities.some((entity) => entity.minerCount > 0)) return true;
  if (!isConveyorBeltId(id) && game.entities.some((entity) => entity.buildingId === id)) return true;
  const requiredTechId = getConstructionDefinition(id)?.requiredTechId;
  return !requiredTechId || isTechnologyCompleted(game, requiredTechId);
}

export function mobileConstructionSearchText(id: ConstructionId): string {
  const definition = getConstructionDefinition(id);
  const aliases = id === "spray_coater" ? "喷涂模块 喷涂 增产 增产剂" : "";
  return `${constructionLabel(id)} ${definition?.name ?? ""} ${id} ${aliases}`.toLocaleLowerCase("zh-CN");
}

export function MobileBuildSheet({ game, snap, placement, beltTier, beltTierMode, query, onQueryChange, onSnap, onClose, onPlacement, onBelt, onCraft, onCraftFleet, onMissingCraft }: {
  game: GameState;
  snap: MobileSheetSnap;
  placement: BuildingId | null;
  beltTier: BeltTier;
  beltTierMode: "auto" | "manual";
  query: string;
  onQueryChange: (query: string) => void;
  onSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
  onPlacement: (buildingId: BuildingId) => void;
  onBelt: (tier: BeltTier) => void;
  onCraft: (constructionId: ConstructionId) => void;
  onCraftFleet: (recipeId: RecipeId) => void;
  onMissingCraft: (constructionId: ConstructionId) => void;
}) {
  const [mode, setMode] = useState<BuildMode>("deploy");
  const [category, setCategory] = useState<BuildCategory>("all");
  const composingQueryRef = useRef(false);
  const compositionValueRef = useRef("");
  const [recent, setRecent] = useState<Array<BuildingId | ConveyorBeltId>>(loadMobileRecentBuilds);
  const remember = (id: BuildingId | ConveyorBeltId) => {
    const next = [id, ...recent.filter((candidate) => candidate !== id)].slice(0, 12);
    setRecent(next);
    try { window.localStorage.setItem(MOBILE_RECENT_BUILD_KEY, JSON.stringify(next)); } catch { /* Recent build history is optional UI state. */ }
  };
  const visible = useMemo(() => {
    const catalog: ConstructionId[] = mode === "deploy"
      ? [...CONSTRUCTION_BUILD_ORDER]
      : CONSTRUCTION.map((definition) => definition.buildingId);
    return catalog.filter((id) => {
    if (!isConstructionVisible(game, id)) return false;
    if (category === "recent" && (!CONSTRUCTION_BUILD_ORDER.includes(id as BuildingId | ConveyorBeltId) || !recent.includes(id as BuildingId | ConveyorBeltId))) return false;
    if (category !== "all" && category !== "recent" && !BUILD_CATEGORIES[category].has(id)) return false;
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return !term || mobileConstructionSearchText(id).includes(term);
    });
  }, [category, game, mode, query, recent]);

  return (
    <MobileSheetFrame title="建造" detail={`${getPlanet(game.activePlanetId).name}施工库存`} snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-build-sheet">
      <div className="mobile-build-controls">
        <div className="mobile-segmented" role="tablist" aria-label="建造模式">
          {(Object.keys(BUILD_MODE_LABELS) as BuildMode[]).map((id) => <button className={mode === id ? "active" : ""} type="button" role="tab" aria-selected={mode === id} key={id} onClick={() => setMode(id)}>{BUILD_MODE_LABELS[id]}</button>)}
        </div>
        <label><Search size={18} /><input
          value={query}
          onCompositionStart={(event) => {
            composingQueryRef.current = true;
            compositionValueRef.current = event.currentTarget.value;
          }}
          onCompositionUpdate={(event) => { compositionValueRef.current = event.currentTarget.value; }}
          onCompositionEnd={(event) => {
            composingQueryRef.current = false;
            compositionValueRef.current = event.currentTarget.value;
            onQueryChange(event.currentTarget.value);
          }}
          onChange={(event) => {
            const value = event.target.value;
            if (composingQueryRef.current && value === "" && compositionValueRef.current !== "") return;
            compositionValueRef.current = value;
            onQueryChange(value);
          }}
          placeholder={mode === "fleet" ? "搜索载具" : "搜索建筑或设备"}
          aria-label="搜索建造项目"
        /></label>
        {mode !== "fleet" ? <nav aria-label="建造分类">{(Object.keys(BUILD_CATEGORY_LABELS) as BuildCategory[]).map((id) => <button className={category === id ? "active" : ""} type="button" key={id} onClick={() => setCategory(id)}>{BUILD_CATEGORY_LABELS[id]}</button>)}</nav> : null}
      </div>
      {mode === "fleet" ? <div className="mobile-build-grid mobile-build-grid--fleet">
        {PORTABLE_FLEET_ITEM_IDS.filter((itemId) => !query.trim() || `${getItem(itemId).name} ${itemId}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))).map((itemId: PortableFleetItemId) => {
          const recipe = getRecipe(itemId)!;
          const count = Math.floor(game.portableFleet?.[itemId] ?? 0);
          const plan = getRecursiveHandcraftPlan(game, recipe.id, 1);
          const craftable = plan.possible;
          const missingTech = recipe.requiredTechId && !isTechnologyCompleted(game, recipe.requiredTechId) ? getTechnology(recipe.requiredTechId)?.name : null;
          const blocker = plan.blocker;
          const blockedLabel = missingTech ? `缺少科技：${missingTech}` : blocker?.reason === "capacity" ? "物资托盘已满" : blocker ? `缺少${getItem(blocker.itemId).name}` : "材料不足";
          return <button className={`mobile-build-card${plan.decisions.length > 1 ? " upstream" : ""}`} type="button" disabled={!craftable} key={itemId} onClick={() => onCraftFleet(recipe.id)} title={craftable ? `制造${getItem(itemId).name}` : blockedLabel}>
            <i><ItemGlyph itemId={itemId} /></i><span><strong>{getItem(itemId).name}</strong><small>{plan.decisions.length > 1 ? `递归加工 ${plan.decisions.length - 1} 段` : "随玩家跨星球携带"}</small></span><em>已有 ×{count}</em><b><Hammer size={15} />制造</b>
          </button>;
        })}
      </div> : <div className={`mobile-build-grid${query.trim() && visible.length <= 2 ? " mobile-build-grid--focused" : ""}`}>
        {visible.map((id) => {
          const count = Math.floor(game.construction[id] ?? 0);
          const isBelt = isConveyorBeltId(id);
          const label = constructionLabel(id);
          const compatible = isBelt || canPlaceBuildingOnPlanet(id as BuildingId, game.activePlanetId, game);
          const plan = getConstructionQuickCraftPlan(game, id);
          const active = isBelt ? beltTierMode === "manual" && beltTier === getBeltTier(id) : placement === id;
          const consumption = plan.consumedItems.slice(0, 2).map((entry) => `${getItem(entry.itemId).name}×${formatQuantityCompact(entry.amount)}`).join("、");
          const disabled = mode === "deploy" && (count < 1 || !compatible);
          const craftUnavailable = mode === "craft" && !plan.possible;
          const accessibleState = mode === "deploy" ? `${label}，施工库存 ${count}` : plan.possible ? `${label}，可以制造` : `${label}，当前不可制造，点击查看原因`;
          return <button className={`mobile-build-card${active ? " active" : ""}${plan.usesUpstream ? " upstream" : ""}${craftUnavailable ? " unavailable" : ""}`} type="button" disabled={disabled} aria-disabled={craftUnavailable || undefined} aria-label={accessibleState} key={id} onClick={() => {
            if (mode === "deploy") {
              if (!CONSTRUCTION_BUILD_ORDER.includes(id as BuildingId | ConveyorBeltId)) return;
              remember(id as BuildingId | ConveyorBeltId);
              if (isBelt) onBelt(getBeltTier(id));
              else onPlacement(id as BuildingId);
              return;
            }
            if (plan.possible) onCraft(id);
            else onMissingCraft(id);
          }} title={mode === "deploy" ? compatible ? `部署${label}` : "当前行星无法部署" : plan.possible ? `制造${label}` : "查看缺失材料"}>
            <i>{constructionBuildIcon(id as BuildingId | ConveyorBeltId)}</i>
            <span><strong>{label}</strong><small>{mode === "deploy" ? `库存 ×${count}` : plan.possible ? consumption || "材料齐备" : plan.blocker ? `安全上限：${getItem(plan.blocker.itemId).name}` : plan.missingTechnology ? `缺科技：${plan.missingTechnology}` : `缺 ${plan.missingItems[0] ? getItem(plan.missingItems[0].itemId).name : "材料"}`}</small></span>
            <b>{mode === "deploy" ? <><Pin size={15} />部署</> : <><Hammer size={15} />制造</>}</b>
          </button>;
        })}
        {visible.length === 0 ? <div className="mobile-sheet-empty"><Box size={24} /><span>没有符合条件的项目</span></div> : null}
      </div>}
    </MobileSheetFrame>
  );
}

type InventoryTab = "tray" | "fleet" | "dyson";
type InventorySort = "amount" | "name" | "kind";

export function MobileInventorySheet({ game, snap, onSnap, onClose, onPickTray, onDropCargo, onDiscardTrayItems, onSetTrayItemLimit }: {
  game: GameState;
  snap: MobileSheetSnap;
  onSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
  onPickTray: (itemId: ItemId) => void;
  onDropCargo: () => void;
  onDiscardTrayItems: (requests: PlanetTrayDiscardRequest[]) => void;
  onSetTrayItemLimit: (value: number) => void;
}) {
  const [tab, setTab] = useState<InventoryTab>("tray");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<InventorySort>("amount");
  const [managementOpen, setManagementOpen] = useState(false);
  const dyson = getDysonEngineeringSnapshot(game, getPlanet(game.activePlanetId).systemId);
  const trayItems = useMemo(() => (Object.entries(game.tray) as Array<[ItemId, number]>).filter(([, amount]) => amount > 0.001).filter(([itemId]) => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return !term || `${getItem(itemId).name} ${itemId}`.toLocaleLowerCase("zh-CN").includes(term);
  }).sort((a, b) => sort === "amount" ? b[1] - a[1] : sort === "name" ? getItem(a[0]).name.localeCompare(getItem(b[0]).name, "zh-CN") : getItem(a[0]).kind.localeCompare(getItem(b[0]).kind)), [game.tray, query, sort]);
  return (
    <MobileSheetFrame title="物资" detail={`${getPlanet(game.activePlanetId).code}物资托盘`} snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-inventory-sheet">
      <section className={`mobile-cargo-slot${game.cargo ? " loaded" : ""}`}>
        <i>{game.cargo ? <ItemGlyph itemId={game.cargo.itemId} /> : <PackageOpen size={24} />}</i>
        <span><small>{game.cargo ? "手提星际载荷" : "光标载荷"}</small><strong>{game.cargo ? getItem(game.cargo.itemId).name : "当前空载"}</strong></span>
        {game.cargo ? <b>×<QuantityValue value={game.cargo.amount} /></b> : null}
        <button type="button" disabled={!game.cargo} onClick={onDropCargo}>{game.cargo ? "全部放回" : "无物资"}</button>
      </section>
      <div className="mobile-inventory-tabs mobile-segmented" role="tablist" aria-label="物资分类">
        <button className={tab === "tray" ? "active" : ""} type="button" role="tab" aria-selected={tab === "tray"} onClick={() => setTab("tray")}>托盘</button>
        <button className={tab === "fleet" ? "active" : ""} type="button" role="tab" aria-selected={tab === "fleet"} onClick={() => setTab("fleet")}>随身载具</button>
        <button className={tab === "dyson" ? "active" : ""} type="button" role="tab" aria-selected={tab === "dyson"} onClick={() => setTab("dyson")}>戴森摘要</button>
      </div>
      {tab === "tray" ? <>
        <div className="mobile-inventory-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前行星物资" aria-label="搜索物资" /></label><button type="button" onClick={() => setSort((current) => current === "amount" ? "name" : current === "name" ? "kind" : "amount")}><ArrowDownUp size={17} />{{ amount: "数量", name: "名称", kind: "类别" }[sort]}</button><button type="button" onClick={() => setManagementOpen(true)}><Settings size={17} />管理</button></div>
        <div className="mobile-inventory-list">{trayItems.map(([itemId, amount]) => <button type="button" key={itemId} onClick={() => onPickTray(itemId)} disabled={Boolean(game.cargo && game.cargo.itemId !== itemId)}><ItemGlyph itemId={itemId} /><span><strong>{getItem(itemId).name}</strong><small>{getItem(itemId).kind === "fluid" ? "流体" : getItem(itemId).kind === "matrix" ? "矩阵" : "物品"}</small></span><b><QuantityValue value={amount} /></b><ChevronRight size={18} /></button>)}{trayItems.length === 0 ? <div className="mobile-sheet-empty"><Box size={24} /><span>没有符合条件的库存</span></div> : null}</div>
        {managementOpen ? <TrayManagementDialog game={game} onDiscard={onDiscardTrayItems} onSetItemLimit={onSetTrayItemLimit} onClose={() => setManagementOpen(false)} /> : null}
      </> : tab === "fleet" ? <div className="mobile-inventory-list">{PORTABLE_FLEET_ITEM_IDS.map((itemId) => <div className="mobile-inventory-row" key={itemId}><ItemGlyph itemId={itemId} /><span><strong>{getItem(itemId).name}</strong><small>跨星球随身携带</small></span><b><QuantityValue value={game.portableFleet?.[itemId] ?? 0} /></b></div>)}</div> : <div className="mobile-dyson-summary"><div><span>在轨太阳帆</span><strong><QuantityValue value={game.dysonSwarm.sailsInOrbit} /></strong></div><div><span>永久结构点</span><strong><QuantityValue value={game.dysonSphere.structurePoints} /></strong></div><div><span>戴森云功率</span><strong><PowerValue valueKw={game.dysonSwarm.generationKw} /></strong></div><div><span>戴森球功率</span><strong><PowerValue valueKw={game.dysonSphere.generationKw} /></strong></div><div><span>理论接收率</span><strong>{Math.round(dyson.theoreticalReceptionRate * 100)}%</strong></div><div><span>接收站实际利用率</span><strong>{Math.round(dyson.receiverUtilization * 100)}%</strong></div><div><span>戴森功率利用率</span><strong>{Math.round(dyson.dysonPowerUtilization * 100)}%</strong></div>{dyson.blockedReceiverCount > 0 ? <div className="warning"><span>受阻接收站</span><strong>{dyson.blockedReceiverCount}/{dyson.configuredReceiverCount}</strong></div> : null}</div>}
    </MobileSheetFrame>
  );
}

function amountRows(values: Partial<Record<ItemId, number>>): Array<[ItemId, number]> {
  return (Object.entries(values) as Array<[ItemId, number]>).filter(([, amount]) => amount > 0.001).sort((a, b) => b[1] - a[1]);
}

function MobileEntityProgress({ game, entity, label, reserveLabel }: { game: GameState; entity: FactoryEntity; label: string; reserveLabel: string }) {
  const storageFlow = entity.kind === "storage" || entity.kind === "splitter" || entity.buildingId === "material_delivery_hub";
  const accumulator = entity.buildingId === "accumulator";
  const stationRoute = entity.kind === "station" && entity.buildingId !== "orbital_collector";
  const mode: WorkProgressMode = storageFlow ? "indeterminate" : accumulator ? "level" : stationRoute ? "route" : entity.buildingId === "construction_center" ? "step" : "cycle";
  const active = !game.paused && entity.utilization > 0.001;
  const semanticKey = stationRoute
    ? `${entity.id}:${(entity.stationRoutes ?? []).map((route) => route.id).join(",") || "idle"}`
    : `${entity.id}:${entity.recipeId ?? entity.resourceId ?? entity.energyMode ?? "idle"}`;
  const displayProgress = useWorkDisplayProgress({
    mode,
    semanticKey,
    snapshotProgress: mode === "indeterminate" ? 0 : stationRoute ? entity.stationProgress ?? 0 : entity.progress,
    cyclesPerSecond: mode === "cycle" || mode === "step" ? getEntityCycleRatePerSimulationSecond(game, entity) : 0,
    effectiveSimulationMultiplier: getEffectiveSimulationMultiplier(game),
    active,
  });
  const percent = Math.round(displayProgress * 100);
  return <div className={`mobile-inspector-progress mobile-inspector-progress--${mode}${active ? " active" : ""}`}><span>{label}</span><strong>{mode === "indeterminate" ? active ? "运行中" : "待机" : `${percent}%`}</strong><i aria-hidden="true"><b style={mode === "indeterminate" ? undefined : { transform: `scaleX(${displayProgress})` }} /></i><small>{entity.productionRate.toFixed(1)}/min · 利用率 {Math.round(entity.utilization * 100)}%{reserveLabel}</small></div>;
}

function MobileBeltLaneControl({ game, belt, onChange }: { game: GameState; belt: BeltConnection; onChange: (beltId: string, targetLanes: number) => void }) {
  const [draft, setDraft] = useState(String(belt.lanes));
  const [error, setError] = useState<string | null>(null);
  const constructionId = getBeltConstructionId(belt.tier);
  const stock = Math.max(0, Math.floor(game.construction[constructionId] ?? 0));
  const decreaseCheck = getBeltLaneAdjustmentCheck(game, belt.id, belt.lanes - 1);
  const increaseCheck = getBeltLaneAdjustmentCheck(game, belt.id, belt.lanes + 1);

  useEffect(() => {
    setDraft(String(belt.lanes));
    setError(null);
  }, [belt.id, belt.lanes]);

  const commit = () => {
    if (!/^\d+$/.test(draft.trim())) {
      setError("并联数量必须为整数");
      return;
    }
    const target = Number(draft.trim());
    const check = getBeltLaneAdjustmentCheck(game, belt.id, target);
    if (!check.ok) {
      setError(check.label);
      return;
    }
    setError(null);
    onChange(belt.id, target);
  };

  return <section className="mobile-belt-lane-control" aria-label="传送带并联数量">
    <header><span>并联线路</span><strong>库存 {stock} · 上限 {MAX_BELT_LANES}</strong></header>
    <div><button type="button" disabled={!decreaseCheck.ok} title={decreaseCheck.label} onClick={() => onChange(belt.id, belt.lanes - 1)} aria-label="减少一条并联线路"><Minus size={18} /></button><input inputMode="numeric" pattern="[0-9]*" min={1} max={Math.max(MAX_BELT_LANES, belt.lanes)} value={draft} onChange={(event) => { setDraft(event.target.value); setError(null); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } else if (event.key === "Escape") { setDraft(String(belt.lanes)); setError(null); } }} aria-label="并联线路目标数量" aria-invalid={Boolean(error)} /><button type="button" disabled={!increaseCheck.ok} title={increaseCheck.label} onClick={() => onChange(belt.id, belt.lanes + 1)} aria-label="增加一条并联线路"><Plus size={18} /></button></div>
    <small>当前吞吐 {getBeltCapacity(belt).toFixed(0)}/s；调整保留线路设置和在途物资。</small>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export function MobileInspectorSheet({ game, snap, entity, belt, selectedCount, onSnap, onClose, onOpenAdvanced, onFocus, onAddEntity, onRemoveEntity, onUpgradeEntity, onUpgradeInterstellarStation, onQuantumAttachment, onOrbitalCollectorQuantumMode, onUpgradeBelt, onBeltLaneCountChange, onEntityLockChange, onRemoveSprayCoater, onOpenResourceSettings, onMaterialDeliverySlotChange, onEjectorOrbitChange }: {
  game: GameState;
  snap: MobileSheetSnap;
  entity: FactoryEntity | null;
  belt: BeltConnection | null;
  selectedCount: number;
  onSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
  onOpenAdvanced: () => void;
  onFocus: () => void;
  onAddEntity: (entityId: string, count: number) => void;
  onRemoveEntity: (entityId: string, count?: number) => void;
  onUpgradeEntity: (entityId: string) => void;
  onUpgradeInterstellarStation: (entityId: string) => void;
  onQuantumAttachment: (entityId: string) => void;
  onOrbitalCollectorQuantumMode: (entityId: string, enabled: boolean) => void;
  onUpgradeBelt: (beltId: string) => void;
  onBeltLaneCountChange: (beltId: string, targetLanes: number) => void;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveSprayCoater: (entityId: string) => void;
  onOpenResourceSettings: () => void;
  onMaterialDeliverySlotChange: (entityId: string, slotIndex: number, mode: MaterialDeliverySlotMode, itemId: ItemId | null) => void;
  onEjectorOrbitChange: (entityId: string, orbitId: string) => void;
}) {
  const [addCount, setAddCount] = useState(1);
  const [stackTargetDraft, setStackTargetDraft] = useState(entity && entity.kind !== "vein" ? String(entity.machineCount) : "1");
  const [stackTargetError, setStackTargetError] = useState<string | null>(null);
  const isMulti = selectedCount > 1;
  const title = isMulti ? `已选择 ${selectedCount} 个节点` : entity ? entity.kind === "vein" ? getItem(entity.resourceId!).name : getBuilding(entity.buildingId!).name : belt ? `${getItem(belt.itemId).name}运输线` : "设备检查器";
  const status = entity ? getEntityOperatingStatus(game, entity) : null;
  const detail = status?.label ?? (belt ? `${belt.lastFlow.toFixed(1)}/s · Mk.${belt.tier}` : isMulti ? "批量操作与生产设置" : "点击画布节点或线路查看状态");
  const inputRows = entity ? amountRows(entity.inputs).slice(0, 4) : [];
  const outputRows = entity ? amountRows(entity.outputs).slice(0, 4) : [];
  const deliverySlots = entity?.buildingId === "material_delivery_hub" ? getMaterialDeliverySlots(entity) : [];
  const deliveryItems = entity?.buildingId === "material_delivery_hub" ? Object.values(ITEMS).filter((item) => {
    const accepts = getBuilding(entity.buildingId!).accepts ?? "any";
    return accepts === "any" || accepts === item.kind || (accepts === "solid" && item.kind === "matrix");
  }) : [];
  const recipe = entity?.recipeId ? getRecipe(entity.recipeId) : undefined;
  const resourceReserve = entity ? getResourceReserveSnapshot(game, entity) : null;
  const ejectorTarget = entity?.buildingId === "em_rail_ejector" ? getEjectorOrbitTargetStatus(game, entity) : null;
  const ejectorOrbits = ejectorTarget ? game.dysonEngineering.orbitsBySystem[ejectorTarget.systemId] ?? [] : [];
  const addAvailable = entity ? Math.floor(game.construction[entity.kind === "vein" ? getExtractorBuildingId(entity.resourceId!) : entity.buildingId!] ?? 0) : 0;
  const stationUpgradeStatus = entity?.buildingId === "interstellar_logistics_station" ? getInterstellarStationUpgradeStatus(game, entity.id) : null;
  const quantumStatus = entity?.buildingId === "interstellar_logistics_station" ? getQuantumAttachmentStatus(game, entity.id) : null;
  const collectorQuantumStatus = entity?.buildingId === "orbital_collector" ? getOrbitalCollectorQuantumStatus(game, entity.id) : null;
  useEffect(() => {
    setAddCount((current) => Math.max(1, Math.min(Math.max(1, addAvailable), current)));
  }, [addAvailable, entity?.id]);
  useEffect(() => {
    setStackTargetDraft(entity && entity.kind !== "vein" ? String(entity.machineCount) : "1");
    setStackTargetError(null);
  }, [entity?.id, entity?.machineCount]);
  const reduceEntityTo = (target: number) => {
    if (!entity || entity.kind === "vein") return;
    const normalized = Math.max(1, Math.min(entity.machineCount, Math.floor(target)));
    setStackTargetDraft(String(normalized));
    setStackTargetError(null);
    if (normalized < entity.machineCount) onRemoveEntity(entity.id, entity.machineCount - normalized);
  };
  const commitStackTarget = () => {
    if (!entity || entity.kind === "vein") return;
    if (!/^\d+$/.test(stackTargetDraft.trim())) {
      setStackTargetError("目标数量必须为正整数");
      return;
    }
    const target = Number(stackTargetDraft.trim());
    if (!Number.isSafeInteger(target) || target < 1 || target > entity.machineCount) {
      setStackTargetError(`请输入 1 至 ${entity.machineCount}`);
      return;
    }
    reduceEntityTo(target);
  };
  return (
    <MobileSheetFrame title={title} detail={detail} snap={snap} allowPeek onSnap={onSnap} onClose={onClose} className={`mobile-inspector-sheet mobile-inspector-sheet--${snap}`}>
      {!entity && !belt && !isMulti ? <div className="mobile-sheet-empty"><Factory size={24} /><span>选择设备或线路后显示运行摘要</span></div> : <>
        <section className="mobile-inspector-status">
          <i className={status?.tone ?? "idle"}>{entity ? entity.kind === "vein" ? <ItemGlyph itemId={entity.resourceId!} /> : constructionBuildIcon(entity.buildingId!) : belt ? <Route size={22} /> : <LayoutTemplate size={22} />}</i>
          <span><small>{status ? "运行状态" : belt ? "线路状态" : "多选摘要"}</small><strong>{status?.label ?? detail}</strong></span>
          {entity ? <b>{Math.round(getEntityPowerFactor(game, entity) * 100)}% 供电</b> : belt ? <b>{Math.round((belt.congestion ?? 0) * 100)}% 拥堵</b> : null}
        </section>
        {entity ? <MobileEntityProgress game={game} entity={entity} label={recipe?.name ?? (entity.kind === "vein" ? "资源采集" : "设备周期")} reserveLabel={resourceReserve ? ` · ${resourceReserve.infinite ? "无限储量" : resourceReserve.exhausted ? "资源已枯竭" : `储量 ${resourceReserve.remaining?.toLocaleString("zh-CN")}/${resourceReserve.capacity?.toLocaleString("zh-CN")} (${resourceReserve.remainingPercent}%)`}` : ""} /> : null}
        {entity?.buildingId === "interstellar_logistics_station" && entity.stationTier !== 2 && stationUpgradeStatus ? <section className={`station-upgrade-control mobile-station-upgrade-control`} aria-label="星际物流站升级"><header><Sparkles size={15} /><span>物流站升级</span><strong>Mk.I → Mk.II</strong></header><p className={`station-upgrade-status station-upgrade-status--${stationUpgradeStatus.blocker}`}>{stationUpgradeStatus.reason}</p></section> : null}
        {entity?.buildingId === "interstellar_logistics_station" && entity.stationTier === 2 && quantumStatus ? <section className="station-upgrade-control mobile-station-upgrade-control" aria-label="量子物流网络接入"><header><Sparkles size={15} /><span>量子物流网络</span><strong>{quantumStatus.mode === "quantum" ? "已接入" : quantumStatus.mode === "transitioning" ? "交接中" : "传统模式"}</strong></header><p className="station-upgrade-status station-upgrade-status--ready">{quantumStatus.mode === "quantum" ? "全宇宙共享物资池已启用" : quantumStatus.mode === "transitioning" ? `等待 ${quantumStatus.bridgeCount} 条旧航线尾货完成` : "接入前保留传统航线"}</p></section> : null}
        {entity && ejectorTarget ? <section className={`mobile-ejector-orbit${ejectorTarget.valid ? "" : " blocked"}`}>
          <header><Orbit size={18} /><span>太阳帆目标轨道</span></header>
          <select value={entity.targetDysonOrbitId ?? ""} disabled={entity.interactionLocked} onChange={(event) => event.target.value && onEjectorOrbitChange(entity.id, event.target.value)} aria-label="选择太阳帆目标轨道">
            {!ejectorTarget.valid && entity.targetDysonOrbitId ? <option value={entity.targetDysonOrbitId}>失效轨道（请重新选择）</option> : null}
            {ejectorOrbits.map((orbit) => <option value={orbit.id} key={orbit.id}>{orbit.name} · {orbit.radius.toLocaleString("zh-CN")}</option>)}
          </select>
          <small>{entity.interactionLocked ? "建筑已锁定，请先解锁再修改轨道。" : ejectorTarget.valid ? `当前恒星系 ${ejectorOrbits.length} 条轨道` : ejectorTarget.reason === "foreign-system" ? "原目标属于其他恒星系，发射已暂停。" : "原目标已删除或失效，发射已暂停。"}</small>
        </section> : null}
        {snap !== "peek" ? <>
          {entity ? <section className={`mobile-inspector-io${entity.buildingId === "storage_mk1" || entity.buildingId === "storage_tank" ? " mobile-inspector-io--storage" : ""}`}><div><header>输入</header>{inputRows.length ? inputRows.map(([itemId, amount]) => <span key={itemId}><ItemGlyph itemId={itemId} /><em>{getItem(itemId).name}</em><strong><QuantityValue value={amount} /></strong></span>) : <small>暂无输入缓存</small>}</div><div><header>输出</header>{outputRows.length ? outputRows.map(([itemId, amount]) => <span key={itemId}><ItemGlyph itemId={itemId} /><em>{getItem(itemId).name}</em><strong><QuantityValue value={amount} /></strong></span>) : <small>暂无输出缓存</small>}</div></section> : null}
          {entity?.buildingId === "material_delivery_hub" ? <section className="mobile-delivery-slot-controls" aria-label="物资配送接口设置"><header><span>三个直送接口</span><small>独立指定或自动识别</small></header>{deliverySlots.map((slot, index) => <article className={`mobile-delivery-slot mobile-delivery-slot--${slot.mode}`} key={index}><div><strong>接口 {index + 1}</strong><small>{slot.mode === "manual" ? "指定物资" : slot.mode === "disabled" ? "已清空" : slot.itemId ? "自动绑定" : "等待识别"}</small></div><ItemCatalogPicker value={slot.itemId ?? undefined} items={deliveryItems} label={`接口 ${index + 1} 指定物资`} onChange={(itemId) => { if (itemId) onMaterialDeliverySlotChange(entity.id, index, "manual", itemId); }} /><footer><button className={slot.mode === "auto" ? "active" : ""} type="button" onClick={() => onMaterialDeliverySlotChange(entity.id, index, "auto", null)}>自动识别</button><button className="danger" type="button" onClick={() => onMaterialDeliverySlotChange(entity.id, index, "disabled", null)}>清空接口</button></footer></article>)}</section> : null}
          {belt ? <section className="mobile-belt-summary"><div><span>物品</span><strong>{getItem(belt.itemId).name}</strong></div><div><span>近期吞吐</span><strong>{belt.lastFlow.toFixed(1)}/s</strong></div><div><span>堆叠</span><strong>×{belt.stackSize ?? 1}</strong></div><div><span>优先级</span><strong>{belt.priority === 2 ? "高" : belt.priority === 1 ? "标准" : "低"}</strong></div></section> : null}
          {belt ? <MobileBeltLaneControl game={game} belt={belt} onChange={onBeltLaneCountChange} /> : null}
          {entity ? <QuantityStepper value={addCount} max={addAvailable} disabled={addAvailable < 1} onChange={setAddCount} label="移动端增加设备" /> : null}
          {entity && entity.kind !== "vein" && entity.buildingId !== "micro_black_hole_connector" && entity.buildingId !== "time_warp_device" ? <section className="mobile-stack-batch-remove" aria-label="批量减少建筑堆叠"><header><span>保留数量</span><strong>当前 ×{entity.machineCount}</strong></header><div><input inputMode="numeric" pattern="[0-9]*" min={1} max={entity.machineCount} value={stackTargetDraft} onChange={(event) => { setStackTargetDraft(event.target.value); setStackTargetError(null); }} onBlur={commitStackTarget} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitStackTarget(); } }} aria-label="移动端建筑堆叠目标数量" aria-invalid={Boolean(stackTargetError)} /><button type="button" disabled={entity.machineCount <= 1} onClick={() => reduceEntityTo(entity.machineCount - 1)}>-1</button><button type="button" disabled={entity.machineCount <= 1} onClick={() => reduceEntityTo(entity.machineCount - 10)}>-10</button><button type="button" disabled={entity.machineCount <= 1} onClick={() => reduceEntityTo(entity.machineCount - 100)}>-100</button><button type="button" disabled={entity.machineCount <= 1} onClick={() => reduceEntityTo(1)}>减至1</button></div>{stackTargetError ? <p role="alert">{stackTargetError}</p> : <small>只减少堆叠，最低保留 1 台；完整拆除使用独立回收操作。</small>}</section> : null}
          <div className="mobile-inspector-actions">
            <button type="button" onClick={onFocus}><Focus size={18} /><span>定位</span></button>
            {entity ? <button type="button" disabled={entity.interactionLocked || addAvailable < 1} onClick={() => onAddEntity(entity.id, addCount)}><Plus size={18} /><span>增加 ×{Math.min(addCount, addAvailable)}</span><b>余 {addAvailable}</b></button> : null}
            {entity ? entity.buildingId === "interstellar_logistics_station" && entity.stationTier !== 2 ? <button type="button" disabled={entity.interactionLocked} title={stationUpgradeStatus?.reason} onClick={() => onUpgradeInterstellarStation(entity.id)}><Sparkles size={18} /><span>升级 Mk.II</span></button> : entity.buildingId === "interstellar_logistics_station" && quantumStatus?.mode === "legacy" ? <button type="button" disabled={entity.interactionLocked} onClick={() => onQuantumAttachment(entity.id)}><Sparkles size={18} /><span>接入量子网络</span></button> : entity.buildingId === "orbital_collector" ? <button type="button" disabled={entity.interactionLocked || collectorQuantumStatus?.mode === "transitioning" || collectorQuantumStatus?.blocker === "technology"} onClick={() => onOrbitalCollectorQuantumMode(entity.id, collectorQuantumStatus?.mode !== "quantum")}><Sparkles size={18} /><span>{collectorQuantumStatus?.mode === "quantum" ? "关闭量子采集" : collectorQuantumStatus?.mode === "transitioning" ? "量子交接中" : "接入量子采集"}</span></button> : <button type="button" disabled={entity.interactionLocked || !canUpgradeEntity(game, entity.id)} onClick={() => onUpgradeEntity(entity.id)}><Sparkles size={18} /><span>升级</span></button> : belt ? <button type="button" disabled={!canUpgradeBelt(game, belt.id)} onClick={() => onUpgradeBelt(belt.id)}><Sparkles size={18} /><span>升级线路</span></button> : null}
            {entity ? <button type="button" onClick={() => onEntityLockChange(entity.id, !entity.interactionLocked)}>{entity.interactionLocked ? <Unlock size={18} /> : <Lock size={18} />}<span>{entity.interactionLocked ? "解锁" : "锁定"}</span></button> : null}
            {entity?.sprayCoaterInstalled ? <button type="button" disabled={entity.interactionLocked} onClick={() => onRemoveSprayCoater(entity.id)}><Trash2 size={18} /><span>拆卸喷涂</span></button> : null}
            {entity ? <button className="danger" type="button" disabled={entity.interactionLocked || entity.kind === "vein" && entity.minerCount < 1} onClick={() => onRemoveEntity(entity.id)}><Trash2 size={18} /><span>{entity.kind === "vein" ? "回收全部采集设备" : "完整回收建筑"}</span></button> : null}
            {resourceReserve?.exhausted ? <button type="button" onClick={onOpenResourceSettings}><Settings size={18} /><span>资源模式</span></button> : null}
            <button type="button" onClick={onOpenAdvanced}><Wrench size={18} /><span>{isMulti ? "批量设置" : "完整设置"}</span></button>
          </div>
        </> : <button className="mobile-inspector-peek-open" type="button" onClick={() => onSnap("half")}><span>查看输入、输出与快捷操作</span><ChevronRight size={20} /></button>}
      </>}
    </MobileSheetFrame>
  );
}

export function MobilePlacementBar({ mode, buildingId, inventory, placementCount, continuous, connectionLabel, selectionCount, beltCount, onCountChange, onContinuousChange, onCancel, onDone, onOpenInspector }: {
  mode: MobileCanvasMode;
  buildingId: BuildingId | null;
  inventory: number;
  placementCount: PlacementCount;
  continuous: boolean;
  connectionLabel?: string | null;
  selectionCount: number;
  beltCount: number;
  onCountChange: (count: PlacementCount) => void;
  onContinuousChange: (enabled: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
  onOpenInspector: () => void;
}) {
  if (mode === "browse") return null;
  if (mode === "place" && buildingId) {
    const index = PLACEMENT_COUNTS.indexOf(placementCount);
    return <div className="mobile-placement-bar" role="toolbar" aria-label="建筑放置状态"><span><i>{constructionBuildIcon(buildingId)}</i><em><small>正在放置</small><strong>{getBuilding(buildingId).name}</strong></em><b>库存 <QuantityValue value={inventory} /></b></span><div className="mobile-placement-stepper"><button type="button" disabled={index <= 0} onClick={() => onCountChange(PLACEMENT_COUNTS[Math.max(0, index - 1)])} aria-label="减少放置数量"><Minus size={18} /></button><strong>{placementCount}</strong><button type="button" disabled={index >= PLACEMENT_COUNTS.length - 1} onClick={() => onCountChange(PLACEMENT_COUNTS[Math.min(PLACEMENT_COUNTS.length - 1, index + 1)])} aria-label="增加放置数量"><Plus size={18} /></button></div><label><input type="checkbox" checked={continuous} onChange={(event) => onContinuousChange(event.target.checked)} /><span>连续</span></label><button type="button" onClick={onCancel}><X size={19} /><span>取消</span></button></div>;
  }
  if (mode === "connect") return <div className="mobile-mode-status mobile-mode-status--connect"><Route size={20} /><span><small>连接模式</small><strong>{connectionLabel ?? "请选择目标端口"}</strong></span><button type="button" onClick={onCancel}><X size={19} />取消</button></div>;
  if (mode === "select") return <div className="mobile-mode-status mobile-mode-status--select"><Check size={20} /><span><small>多选模式</small><strong>{selectionCount} 节点 · {beltCount} 线路</strong></span>{selectionCount + beltCount > 0 ? <button type="button" onClick={onOpenInspector}><Wrench size={18} />批量操作</button> : null}<button type="button" onClick={onDone}>完成</button></div>;
  if (mode === "place") return null;
  const labels: Record<Exclude<MobileCanvasMode, "browse" | "place" | "connect" | "select">, string> = { layout: "拖动节点调整布局，空白区域仍可平移", region: "在空白画布拖拽创建生产区域" };
  return <div className={`mobile-mode-status mobile-mode-status--${mode}`}>{mode === "layout" ? <LayoutTemplate size={20} /> : <Zap size={20} />}<span><small>{mode === "layout" ? "布局模式" : "生产区域"}</small><strong>{labels[mode]}</strong></span><button type="button" onClick={onDone}>完成</button></div>;
}

export function MobileSelectionContextBar({ selectedCount, beltCount, canUpgrade, canUpgradeBelts, canLock, canUnlock, onFocus, onCopy, onUpgrade, onUpgradeBelts, onBatchIncrease, onLock, onUnlock, onRemove, onClear }: {
  selectedCount: number;
  beltCount: number;
  canUpgrade: boolean;
  canUpgradeBelts: boolean;
  canLock: boolean;
  canUnlock: boolean;
  onFocus: () => void;
  onCopy: () => void;
  onUpgrade: () => void;
  onUpgradeBelts: () => void;
  onBatchIncrease: (amount: number) => void;
  onLock: () => void;
  onUnlock: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const [customIncrease, setCustomIncrease] = useState("");
  const applyCustomIncrease = () => {
    if (!/^\d+$/.test(customIncrease.trim())) return;
    const amount = Number(customIncrease.trim());
    if (Number.isSafeInteger(amount) && amount >= 1 && amount <= 1_000_000) onBatchIncrease(amount);
  };
  if (selectedCount + beltCount === 0) return null;
  return <div className="mobile-selection-context" role="toolbar" aria-label="选区快捷操作"><span><Check size={18} /><strong>{selectedCount}</strong> 节点 · <strong>{beltCount}</strong> 线路</span><nav><button type="button" onClick={onFocus} disabled={selectedCount === 0}><Focus size={18} /><small>定位</small></button><button type="button" onClick={onCopy} disabled={selectedCount === 0}><LayoutTemplate size={18} /><small>蓝图</small></button><button type="button" onClick={selectedCount > 0 ? onUpgrade : onUpgradeBelts} disabled={selectedCount > 0 ? !canUpgrade : !canUpgradeBelts}><Sparkles size={18} /><small>升级</small></button>{[1, 10, 100].map((amount) => <button type="button" key={amount} onClick={() => onBatchIncrease(amount)}><Plus size={18} /><small>+{amount}</small></button>)}<label className="mobile-selection-context__custom"><input value={customIncrease} onChange={(event) => setCustomIncrease(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyCustomIncrease(); } }} inputMode="numeric" pattern="[0-9]*" min={1} max={1_000_000} placeholder="自定义" aria-label="自定义批量增加量" /><button type="button" onClick={applyCustomIncrease} aria-label="应用自定义批量增加量"><Check size={16} /></button></label><button type="button" onClick={onLock} disabled={!canLock}><Lock size={18} /><small>锁定</small></button><button type="button" onClick={onUnlock} disabled={!canUnlock}><Unlock size={18} /><small>解锁</small></button><button className="danger" type="button" onClick={onRemove}><Trash2 size={18} /><small>回收</small></button><button type="button" onClick={onClear}><X size={18} /><small>清除</small></button></nav></div>;
}

export function MobileConnectionNotice({ label, tone }: { label: string; tone: "ready" | "blocked" | "warning" }) {
  return <div className={`mobile-connection-notice mobile-connection-notice--${tone}`}>{tone === "ready" ? <Check size={17} /> : <CircleAlert size={17} />}<span>{label}</span></div>;
}
