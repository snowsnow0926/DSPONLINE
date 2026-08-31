import {
  Atom,
  AlertTriangle,
  ArrowUp,
  BarChart3,
  BatteryCharging,
  BatteryFull,
  BookOpen,
  Box,
  Check,
  Command,
  ChevronLeft,
  ChevronRight,
  CircuitBoard,
  ClipboardCopy,
  ClipboardPaste,
  Database,
  Droplets,
  Factory,
  Flame,
  Flag,
  FlaskConical,
  Gauge,
  Hammer,
  GitFork,
  Globe2,
  GripVertical,
  House,
  History,
  Layers3,
  LayoutGrid,
  ListChecks,
  ListPlus,
  MoreHorizontal,
  Minus,
  Orbit,
  PackageOpen,
  PanelRight,
  Pause,
  Pickaxe,
  Play,
  Plus,
  Power,
  RadioTower,
  Route,
  Rows3,
  Rocket,
  RotateCcw,
  Satellite,
  Search,
  Settings,
  Sparkles,
  Sun,
  Telescope,
  ThermometerSun,
  LockKeyhole,
  Trash2,
  Unlock,
  Wind,
  Wrench,
  Zap,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useHorizontalPan } from "../hooks/useHorizontalPan";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { ItemCatalogPicker, RecipeCatalogPicker } from "./CatalogPicker";
import { StableTextInput } from "./CompositionSafeInput";
import { QuantityStepper } from "./QuantityStepper";
import { CAMPAIGN_TASKS, getCampaignSnapshot, getCampaignTaskDeficits } from "../game/campaign";
import { CONSTRUCTION, FUEL_ENERGY_MJ, ITEMS, PLANET_LIST, RECIPES, getBeltConstructionId, getBeltTier, getBuilding, getBuildingUpgradeTarget, getConstructionCatalogIds, getConstructionDefinition, getExtractorBuildingId, getFuelItemIdsForBuilding, getItem, getNextBeltTier, getPlanet, getProliferator, getRecipe, getRecipesForBuilding, getTechnology, isConstructionDeployable, isConstructionInCategory, isConveyorBeltId } from "../game/content";
 import { MATERIAL_DELIVERY_SLOT_COUNT, MAX_BELT_LANES, MAX_BUILDING_STACK_COUNT, MAX_MANUAL_CRAFT_BATCHES, MAX_PLANET_TRAY_ITEM_LIMIT, MIN_PLANET_TRAY_ITEM_LIMIT, PORTABLE_FLEET_ITEM_IDS, POWER_GRID_IDS, POWER_GRID_LABELS, canPlaceBuildingOnPlanet, canQueueHandcraftRecipe, canSetBeltStackSize, canUpgradeBelt, canUpgradeEntity, findInterstellarPeer, findPlanetaryPeer, getBeltCapacity, getBeltLaneAdjustmentCheck, getBeltNetworkIds, getConstructionAutomationStatus, getConstructionCraftDeficits, getConstructionQuickCraftPlan, getDysonEngineeringSnapshot, getDysonShellCapacity, getEjectorOrbitTargetStatus, getEntityExtraProductBonus, getEntityOperatingStatus, getEntityOutputCapacity, getEntityPowerFactor, getEntityProliferatorPowerMultiplier, getEntityProliferatorSpeedMultiplier, getInterstellarCargoCapacity, getInterstellarTripSeconds, getMaterialDeliveryItems, getMaterialDeliverySlots, getMaxConstructionQuickCraftBatches, getMaxRecursiveHandcraftBatches, getMiningSpeedMultiplier, getOrbitalCollectorQuantumStatus, getPlanetaryCargoCapacity, getPlanetaryTripSeconds, getPlanetMetrics, getPlanetTrayItemLimit, getPowerGridMetrics, getProliferatorSprayCost, getQuantumAttachmentStatus, getRayReceiverCapacityKw, getRecursiveHandcraftPlan, getResourceReserveSnapshot, getSprayCoaterInstallCheck, getSprayCoaterRemovalRefund, getStationActiveRoutes, getStationBusyVehicleCount, getStationDroneCapacity, getStationFleetDiagnostic, getStationMinimumCargo, getStationSlotCapacity, getStationSlots, getStationVesselCapacity, getStationWarperAutoRefillTarget, getStationWarperCapacity, getStationWarperRefillSnapshot, getTimeWarpRequiredPowerKw, isEntityInPowerCoverage, isHandcraftableRecipe, isPlanetColonized, isPortableFleetItem, isProliferatorEligible, isTechnologyCompleted, stationRouteRequiresWarp } from "../game/engine";
import { getPlanetDisplayName, getPlanetIndustrialProfile, getPlanetOrbitalYields, specializationApplies } from "../game/galaxy";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  FactoryRunStatusReadModel,
  PlanetNavigationReadModel,
  SelectedBeltReadModel,
  SelectedEntityReadModel,
} from "../game/factoryReadModels";
import { analyzeBeltNetwork } from "../game/network";
import { ACTIVITY_MATERIAL_IDS } from "../game/activity";
import { getOrbitalCargoPortItems } from "../game/stationCargoTerminal";
import { getInterstellarStationUpgradeStatus } from "../game/systemSpaceStation";
import type {
  BeltRouteMode,
  BeltTier,
  BeltConnection,
  BuildingId,
  CargoStackSize,
  CargoStack,
  ConstructionId,
  ConveyorBeltId,
  DraggedItemSourceKind,
  EnergyMode,
  FactoryEntity,
  GameState,
  InterstellarRoutePolicy,
  ItemId,
  MaterialDeliverySlotMode,
  PlacementCount,
  PlanetId,
  PortableFleetItemId,
  ProliferatorMode,
  ProliferatorTier,
  RecipeId,
  StationLogisticsMode,
  StationLogisticsScope,
  StationMinimumLoad,
  PowerGridId,
  PowerPriority,
} from "../game/types";
import type { PlanetTrayDiscardRequest } from "../game/engine";
import { formatQuantityCompact } from "../game/quantityFormat";
import { formatPowerKw } from "../game/units";
import { TrayManagementDialog } from "./TrayManagementDialog";
import { GalacticActivityPanel } from "./GalacticActivityPanel";
import { QuantityValue } from "./QuantityValue";
import { PowerValue } from "./PowerValue";
import type { GalacticActivityPublicStatus } from "../game/galacticActivity";
import { DEFAULT_INSPECTOR_SECTION_ORDER, readInspectorLayoutPreference, writeInspectorLayoutPreference, type InspectorLayoutPreferenceV1, type InspectorSectionId } from "../game/inspectorLayout";
import { useAppLocale } from "../i18n/locale";
import { useGameDialog } from "./GameDialogProvider";

function ItemMark({ itemId }: { itemId: ItemId }) {
  return <ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} className="item-mark" /></ItemHoverCard>;
}

interface ResourceRailProps {
  game: GameState;
  onOpenCampaign: () => void;
  onOpenDysonPlanner: () => void;
  onPickTray: (itemId: ItemId) => void;
  onDropCargo: () => void;
  onDropDraggedItem: (itemId: ItemId, sourceKind: DraggedItemSourceKind, sourceId?: string) => void;
  onSetTrayItemLimit: (value: number) => void;
  onDiscardTrayItems: (requests: PlanetTrayDiscardRequest[]) => void;
}

export function ResourceRail({ game, onOpenCampaign, onOpenDysonPlanner, onPickTray, onDropCargo, onDropDraggedItem, onSetTrayItemLimit, onDiscardTrayItems }: ResourceRailProps) {
  const [dragOver, setDragOver] = useState(false);
  const [trayManagementOpen, setTrayManagementOpen] = useState(false);
  const [trayLimitError, setTrayLimitError] = useState<string | null>(null);
  const trayItemLimit = getPlanetTrayItemLimit(game);
  const [trayLimitDraft, setTrayLimitDraft] = useState(String(trayItemLimit));
  useEffect(() => setTrayLimitDraft(String(trayItemLimit)), [game.activePlanetId, trayItemLimit]);
  const commitTrayItemLimit = () => {
    const normalized = trayLimitDraft.trim().replaceAll(",", "");
    if (!/^[0-9]+$/.test(normalized)) {
      setTrayLimitError("请输入十进制正整数，不支持小数、负数或指数格式");
      return;
    }
    const next = Number(normalized);
    if (!Number.isSafeInteger(next) || next < MIN_PLANET_TRAY_ITEM_LIMIT || next > MAX_PLANET_TRAY_ITEM_LIMIT) {
      setTrayLimitError("允许范围为 1,000 至 100,000,000");
      return;
    }
    setTrayLimitError(null);
    setTrayLimitDraft(String(next));
    onSetTrayItemLimit(next);
  };
  const trayItems = useMemo(() => (Object.entries(game.tray) as Array<[ItemId, number]>)
    .filter(([, amount]) => amount > 0.001)
    .sort((a, b) => b[1] - a[1]), [game.tray]);
  const campaign = useMemo(() => game.campaign.activeTaskId === null ? {
    activeTask: null,
    completedCount: Math.min(CAMPAIGN_TASKS.length, game.campaign.completedTaskIds.length),
    totalCount: CAMPAIGN_TASKS.length,
  } : getCampaignSnapshot(game), [
    game.blueprints,
    game.belts,
    game.campaign,
    game.dysonSphere,
    game.dysonSwarm,
    game.endgame,
    game.entities,
    game.exploration,
    game.manualMined,
    game.planetMetrics,
    game.research,
    game.totalProduced,
  ]);
  const activeTask = campaign.activeTask;
  const activeDeficits = useMemo(() => activeTask ? getCampaignTaskDeficits(game, activeTask) : [], [
    activeTask,
    game.activePlanetId,
    game.cargo,
    game.entities,
    game.planetTrays,
    game.tray,
  ]);
  const dysonGenerationKw = game.dysonSwarm.generationKw + game.dysonSphere.generationKw;
  const shellCapacity = useMemo(() => getDysonShellCapacity(game), [game.dysonPlans, game.dysonSphere.structurePoints]);
  const activeSystemId = getPlanet(game.activePlanetId).systemId;
  const dysonEngineering = useMemo(() => getDysonEngineeringSnapshot(game, activeSystemId), [
    activeSystemId,
    game.dysonEngineering,
    game.dysonPlans,
    game.endgame,
    game.entities,
    game.galaxy,
    game.research,
    game.settings,
  ]);
  const swarmLoad = dysonEngineering.dysonPowerUtilization * 100;
  const cargoIsPortableFleet = Boolean(game.cargo && isPortableFleetItem(game.cargo.itemId));
  const onPickTrayRef = useRef(onPickTray);
  onPickTrayRef.current = onPickTray;
  const trayRows = useMemo(() => trayItems.map(([itemId, amount]) => (
    <button
      className="tray-row"
      type="button"
      key={itemId}
      draggable={!game.cargo || game.cargo.itemId === itemId}
      onClick={() => onPickTrayRef.current(itemId)}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/factory-item", itemId);
        event.dataTransfer.setData("application/factory-source-kind", "tray");
        event.dataTransfer.effectAllowed = "move";
      }}
      title={`拿取${ITEMS[itemId].name}`}
    >
      <ItemMark itemId={itemId} />
      <ItemHoverCard itemId={itemId} className="item-reference--tray"><span>{ITEMS[itemId].name}</span></ItemHoverCard>
      <ItemHoverCard itemId={itemId} className="item-reference--tray"><strong><QuantityValue value={amount} interactive={false} /></strong></ItemHoverCard>
    </button>
  )), [game.cargo?.itemId, trayItems]);

  return (
    <aside
      className={`resource-rail${dragOver ? " resource-rail--drop-ready" : ""}`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("application/factory-item")) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("application/factory-item")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        const itemId = event.dataTransfer.getData("application/factory-item") as ItemId;
        if (!itemId) return;
        event.preventDefault();
        setDragOver(false);
        const sourceKind = event.dataTransfer.getData("application/factory-source-kind") as DraggedItemSourceKind;
        const sourceId = event.dataTransfer.getData("application/factory-source-id") || undefined;
        onDropDraggedItem(itemId, sourceKind, sourceId);
      }}
    >
      <section className={`rail-block cargo-block${game.cargo ? " rail-block--cargo-drop" : ""}`} onClick={(event) => {
        if (!game.cargo || (event.target instanceof Element && event.target.closest("button"))) return;
        onDropCargo();
      }}>
        <div className="rail-heading">
          <span>{cargoIsPortableFleet ? "随身载具载荷" : game.cargo ? "手提星际载荷" : "光标载荷"}</span>
          <strong>{game.cargo ? "1 / 1" : "0 / 1"}</strong>
        </div>
        <button
          className={`cargo-slot${game.cargo ? " cargo-slot--loaded" : ""}`}
          type="button"
          aria-disabled={!game.cargo}
          onClick={onDropCargo}
          onDragOver={(event) => { if (event.dataTransfer.types.includes("application/factory-item")) event.preventDefault(); }}
          title={game.cargo ? cargoIsPortableFleet ? "放入底部随身载具栏" : "放入物资托盘" : "光标当前未携带物资"}
        >
          {game.cargo ? (
            <>
              <ItemMark itemId={game.cargo.itemId} />
              <span>{ITEMS[game.cargo.itemId].name}</span>
              <strong>×<QuantityValue value={game.cargo.amount} interactive={false} /></strong>
              <ChevronRight size={14} />
            </>
          ) : <><PackageOpen size={18} /><span>空载</span></>}
        </button>
      </section>

      <section className="rail-block dyson-block">
        <div className="rail-heading">
          <span>戴森系统</span>
          <strong>{game.dysonSphere.structurePoints > 0 ? "永久结构运行" : game.dysonSwarm.sailsInOrbit > 0 ? "戴森云运行" : "尚未建立"}</strong>
        </div>
        <div className="dyson-orbit-readout">
          <i><Sun size={18} /></i>
          <span><small>在轨太阳帆</small><strong><QuantityValue value={game.dysonSwarm.sailsInOrbit} /></strong></span>
          <Orbit size={20} />
        </div>
        <div className="dyson-sphere-readout">
          <span><Rocket size={14} /><small>永久结构</small><strong><QuantityValue value={game.dysonSphere.structurePoints} unit="点" /></strong></span>
          <span><Orbit size={14} /><small>壳面太阳帆</small><strong><QuantityValue value={game.dysonSphere.shellSails} /> / <QuantityValue value={shellCapacity} /></strong></span>
        </div>
        <div className="dyson-load" role="progressbar" aria-label="戴森系统接收负载" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(swarmLoad)}>
          <i><b style={{ width: `${swarmLoad}%` }} /></i>
          <span><PowerValue valueKw={dysonGenerationKw} interactive={false} /> 总功率</span>
          <strong><PowerValue valueKw={game.dysonSwarm.receiverLoadKw} interactive={false} /> 接收</strong>
        </div>
        <div className="dyson-counts">
          <span>累计发射 <strong><QuantityValue value={game.dysonSwarm.totalLaunched} /></strong></span>
          <span>已衰减 <strong><QuantityValue value={game.dysonSwarm.totalExpired} /></strong></span>
        </div>
        <div className="dyson-counts">
          <span>运载火箭 <strong><QuantityValue value={game.dysonSphere.totalRocketsLaunched} /></strong></span>
          <span>永久吸附 <strong><QuantityValue value={game.dysonSphere.totalSailsAbsorbed} /></strong></span>
        </div>
        <div className="dyson-engineering-readout">
          <span><RadioTower size={11} />{dysonEngineering.launchEnabled ? { balanced: "均衡调度", swarm: "太阳帆优先", sphere: "火箭优先" }[dysonEngineering.launchMode] : "发射暂停"}<strong>{Math.round(dysonEngineering.launchThrottle * 100)}%</strong></span>
          <span><Gauge size={11} />理论接收<strong>{Math.round(dysonEngineering.theoreticalReceptionRate * 100)}%</strong></span>
          <span><RadioTower size={11} />接收站利用<strong>{Math.round(dysonEngineering.receiverUtilization * 100)}%</strong></span>
          <span><Sun size={11} />功率利用<strong>{Math.round(dysonEngineering.dysonPowerUtilization * 100)}%</strong></span>
          {dysonEngineering.blockedReceiverCount > 0 ? <span className="warning"><AlertTriangle size={11} />受阻接收站<strong>{dysonEngineering.blockedReceiverCount}</strong></span> : null}
          <span><Atom size={11} />反物质回馈<strong><PowerValue valueKw={dysonEngineering.feedbackGenerationKw} /></strong></span>
        </div>
        <button className="dyson-planner-command" type="button" onClick={onOpenDysonPlanner} title="打开戴森球规划" aria-label="打开戴森球规划"><Orbit size={14} />戴森球规划</button>
      </section>

      <section className={`rail-block tray-block${game.cargo ? " rail-block--cargo-drop" : ""}`} onClickCapture={(event) => {
        if (!game.cargo || (event.target instanceof Element && event.target.closest(".tray-limit-control, .tray-management-trigger, .tray-management"))) return;
        event.preventDefault();
        event.stopPropagation();
        onDropCargo();
      }}>
        <div className="rail-heading">
          <span>{getPlanet(game.activePlanetId).code}物资托盘</span>
          <button className="rail-heading-command tray-management-trigger" type="button" onClick={() => setTrayManagementOpen(true)} title="管理当前行星物资" aria-label="管理当前行星物资"><Settings size={14} /></button>
        </div>
        <label className="tray-limit-control" onClick={(event) => event.stopPropagation()}>
          <span>单种物资上限</span>
          <input
            type="number"
            min={MIN_PLANET_TRAY_ITEM_LIMIT}
            max={MAX_PLANET_TRAY_ITEM_LIMIT}
            step={1000}
            inputMode="numeric"
            value={trayLimitDraft}
            aria-label={`${getPlanetDisplayName(game, game.activePlanetId)}单种物资上限`}
            onChange={(event) => setTrayLimitDraft(event.target.value)}
            onBlur={commitTrayItemLimit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTrayLimitDraft(String(trayItemLimit));
                event.currentTarget.blur();
              }
            }}
          />
          <small>1千–1亿</small>
        </label>
        <div className="tray-limit-presets" role="group" aria-label="物资托盘单种物资上限预设">
          {([10_000, 100_000, 1_000_000, 100_000_000] as const).map((value) => <button type="button" className={trayItemLimit === value ? "active" : ""} key={value} onClick={() => { setTrayLimitDraft(String(value)); setTrayLimitError(null); onSetTrayItemLimit(value); }}>{value === 10_000 ? "1万" : value === 100_000 ? "10万" : value === 1_000_000 ? "100万" : "1亿"}</button>)}
        </div>
        {trayLimitError ? <p className="tray-limit-error" role="alert">{trayLimitError}</p> : null}
        <div className="tray-list">
          {trayItems.length === 0 ? (
            <div className="tray-empty"><Box size={18} /><span>暂无库存</span></div>
          ) : trayRows}
        </div>
      </section>
      {trayManagementOpen ? <TrayManagementDialog game={game} onDiscard={onDiscardTrayItems} onSetItemLimit={onSetTrayItemLimit} onClose={() => setTrayManagementOpen(false)} /> : null}

      <section className="rail-block campaign-summary-block">
        <div className="rail-heading">
          <span>当前任务</span>
          <button type="button" className="rail-heading-command" onClick={onOpenCampaign} title="打开主线任务中心" aria-label="打开主线任务中心"><ListChecks size={14} /></button>
          <strong>{campaign.completedCount}/{campaign.totalCount}</strong>
        </div>
        {activeTask ? (
          <button className="campaign-summary-command" type="button" onClick={onOpenCampaign} title="打开主线任务中心">
            <i><Flag size={15} /></i>
            <span><strong>{activeTask.title}</strong><small>{activeTask.progress.current} / {activeTask.progress.target} · {activeTask.description}</small></span>
            <ChevronRight size={15} />
          </button>
        ) : <div className="campaign-summary-complete"><Check size={14} />全部任务已完成</div>}
        {activeTask && activeDeficits.length > 0 ? (
          <div className="campaign-summary-deficits"><span>缺料</span>{activeDeficits.slice(0, 3).map((deficit) => <span key={deficit.itemId}>{ITEMS[deficit.itemId].name} ×{formatQuantityCompact(deficit.amount)}</span>)}</div>
        ) : null}
      </section>
    </aside>
  );
}

export function PlanetNavigator({ model, onPlanetChange }: { model: PlanetNavigationReadModel; onPlanetChange: (planetId: PlanetId) => boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const visiblePlanets = useMemo(() => {
    const rows = new Map(model.planets.rows.map((row) => [row.planetId, row] as const));
    const activeSystemId = rows.get(model.activePlanetId)?.systemId;
    if (!activeSystemId) return [];
    return PLANET_LIST
      .filter((planet) => planet.systemId === activeSystemId)
      .flatMap((planet) => {
        const row = rows.get(planet.id);
        return row?.discovered ? [{ planet, row }] : [];
      });
  }, [model]);
  return (
    <nav className={`planet-navigator nodrag nopan${collapsed ? " planet-navigator--collapsed" : ""}`} aria-label="行星切换">
      {!collapsed ? visiblePlanets.map(({ planet, row }) => {
        const active = row.active;
        const unlocked = row.colonized;
        return (
          <button type="button" className={`${active ? "active" : ""}${unlocked ? "" : " locked"}`} aria-pressed={active} key={planet.id} disabled={!unlocked} onClick={() => onPlanetChange(planet.id)} title={unlocked ? `切换到${row.displayName}` : "完成星际物流系统科技后开放"}>
            <i style={{ color: unlocked ? planet.color : undefined }}>{unlocked ? <Orbit size={15} /> : <LockKeyhole size={15} />}</i>
            <span><strong>{row.displayName}</strong><small>{unlocked ? `${row.code} · ${planet.environment}` : "星图锁定 · 需要星际物流系统"}</small></span>
            <em>{row.deviceCount}</em>
            <b className={row.powerFactor < 0.999 ? "warning" : ""}>{Math.round(row.powerFactor * 100)}%</b>
          </button>
        );
      }) : null}
      <button className="planet-navigator__toggle" type="button" onClick={() => setCollapsed((current) => !current)} title={collapsed ? "展开行星切换" : "折叠行星切换"} aria-label={collapsed ? "展开行星切换" : "折叠行星切换"} aria-expanded={!collapsed}>
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </nav>
  );
}

type InspectorTab = "inspect" | "fabricate";

interface InspectorPanelProps {
  readOnly?: boolean;
  game: GameState;
  inspectorReadModel: FactoryInspectorSummaryReadModel;
  multiSelectionReadModel: FactoryMultiSelectionSummaryReadModel;
  multiSelectedBelts: BeltConnection[];
  selectedEntities: FactoryEntity[];
  selectedEntity: FactoryEntity | null;
  selectedBelt: BeltConnection | null;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onRecipeChange: (entityId: string, recipeId: RecipeId) => void;
  onEjectorOrbitChange: (entityId: string, orbitId: string) => void;
  onLogisticsItemChange: (entityId: string, itemId: ItemId) => void;
  onMaterialDeliverySlotChange: (entityId: string, slotIndex: number, mode: MaterialDeliverySlotMode, itemId: ItemId | null) => void;
  onPickEntityInput: (entityId: string, itemId: ItemId) => void;
  onOpenOrbitalStation: (tab: "construction" | "contracts") => void;
  onOrbitalCargoPortClear: (entityId: string, portIndex: 0 | 1 | 2 | 3) => void;
  onFuelChange: (entityId: string, itemId: ItemId) => void;
  onEnergyModeChange: (entityId: string, mode: EnergyMode) => void;
  onPowerGridChange: (entityId: string, gridId: PowerGridId) => void;
  onPowerPriorityChange: (entityId: string, priority: PowerPriority) => void;
  onGenerationPriorityChange: (entityId: string, priority: PowerPriority) => void;
  onStationModeChange: (entityId: string, mode: "supply" | "demand") => void;
  onStationVesselAdjust: (entityId: string, delta: number) => void;
  onStationDroneAdjust: (entityId: string, delta: number) => void;
  onStationFleetTarget: (entityId: string, kind: "drone" | "vessel", target: number) => void;
  onStationFleetFill: (entityId: string, kind: "drone" | "vessel") => void;
  onStationWarperAdjust: (entityId: string, delta: number) => void;
  onStationWarpEnabled: (entityId: string, enabled: boolean) => void;
  onStationWarperAutoRefillChange: (entityId: string, enabled: boolean) => void;
  onStationWarperTargetChange: (entityId: string, target: number) => void;
  onStationHubChange: (entityId: string, enabled: boolean, priority: 0 | 1 | 2) => void;
  onStationMinimumLoadChange: (entityId: string, minimumLoad: StationMinimumLoad) => void;
  onStationSlotItemChange: (entityId: string, slotIndex: number, itemId: ItemId | null) => void;
  onStationSlotModeChange: (entityId: string, slotIndex: number, scope: StationLogisticsScope, mode: StationLogisticsMode) => void;
  onStationSlotMinimumLoadChange: (entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => void;
  onStationSlotLimitsChange: (entityId: string, slotIndex: number, minStock: number, maxStock: number) => void;
  onStationSlotPriorityChange: (entityId: string, slotIndex: number, priority: 0 | 1 | 2) => void;
  onStationSlotRoutePolicyChange: (entityId: string, slotIndex: number, routePolicy: InterstellarRoutePolicy) => void;
  onStationSlotWarperBudgetChange: (entityId: string, slotIndex: number, warperBudget: number) => void;
  onSplitterModeChange: (entityId: string, mode: "balanced" | "priority") => void;
  onBeltPriorityChange: (beltId: string, priority: 0 | 1 | 2) => void;
  onBeltLaneCountChange: (beltId: string, targetLanes: number) => void;
  onBeltStackSizeChange: (beltId: string, stackSize: CargoStackSize) => void;
  onBeltMonitorChange: (beltId: string, enabled: boolean) => void;
  onBeltRouteModeChange: (beltId: string, routeMode: BeltRouteMode) => void;
  onBeltRouteOffsetChange: (beltId: string, routeOffsetY: number) => void;
  onApplyBeltConfigurationToNetwork: (beltId: string) => void;
  onFocusBeltNetwork: (beltId: string) => void;
  onRemoveBeltNetwork: (beltId: string) => void;
  focusedBeltNetworkId: string | null;
  onUpgradeBeltNetwork: (beltId: string) => void;
  onCopyBeltConfiguration: (beltId: string) => void;
  onPasteBeltConfiguration: (beltId: string) => void;
  hasCopiedBeltConfiguration: boolean;
  onCraft: (buildingId: ConstructionId, batches: number) => void;
  onCraftItem: (recipeId: RecipeId, batches: number) => void;
  onQueueCraftItem: (recipeId: RecipeId, batches: number) => void;
  onCancelCraftQueue: (entryId: string) => void;
  onAddEntity: (entityId: string, count: number) => void;
  onEntityStackTarget: (entityId: string, target: number) => { ok: boolean; error?: string };
  onUpgradeEntity: (entityId: string) => void;
  onUpgradeInterstellarStation: (entityId: string) => void;
  onQuantumAttachment: (entityId: string) => void;
  onOrbitalCollectorQuantumMode: (entityId: string, enabled: boolean) => void;
  onUpgradeBelt: (beltId: string) => void;
  onInstallSprayCoater: (entityId: string) => void;
  onRemoveSprayCoater: (entityId: string) => void;
  onOpenResourceSettings: () => void;
  onProliferatorConfiguration: (entityId: string, tier: ProliferatorTier, mode: ProliferatorMode) => void;
  onBatchRecipeChange: (entityIds: string[], recipeId: RecipeId) => void;
  onBatchEjectorOrbitChange: (entityIds: string[], orbitId: string) => void;
  onBatchInstallSprayCoater: (entityIds: string[]) => void;
  onBatchProliferatorConfiguration: (entityIds: string[], tier: ProliferatorTier, mode: ProliferatorMode) => void;
  onRemoveEntity: (entityId: string, count?: number) => void;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveBelt: (beltId: string) => void;
  onOpenConstructionCenter: () => void;
  onGalacticExporterPausedChange: (entityId: string, paused: boolean) => void;
  onBlackHolePausedChange: (entityId: string, paused: boolean, confirmActivation?: boolean) => void;
  onTimeWarpControllerChange: (entityId: string) => void;
  onTimeWarpEnabledChange: (enabled: boolean) => void;
  onTimeWarpRequestedMultiplierChange: (multiplier: number) => void;
  galacticActivityStatus: GalacticActivityPublicStatus | null;
  fabricatorFocusItemId?: ItemId | null;
  onOpenTutorial?: (sectionId?: string) => void;
}

type NumericItemRecord = Readonly<Record<string, number | undefined>>;

function compareInspectorItemIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function completeInspectorItemRowsMatch(
  record: NumericItemRecord,
  rows: SelectedEntityReadModel["inputItems"],
): boolean {
  const entries = Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => compareInspectorItemIds(left, right));
  return !rows.truncated && rows.totalCount === rows.rows.length &&
    rows.rows.length === entries.length && rows.rows.every((row, index) => {
      const entry = entries[index];
      return entry?.[0] === row.itemId && entry[1] === row.amount;
    });
}

function desktopEntitySummaryMatches(entity: FactoryEntity, row: SelectedEntityReadModel): boolean {
  return row.entityId === entity.id && row.planetId === entity.planetId && row.kind === entity.kind &&
    row.position.x === entity.position.x && row.position.y === entity.position.y &&
    row.interactionLocked === entity.interactionLocked && row.buildingId === (entity.buildingId ?? null) &&
    row.resourceId === (entity.resourceId ?? null) && row.recipeId === (entity.recipeId ?? null) &&
    row.storedItemId === (entity.storedItemId ?? null) && row.fuelItemId === (entity.fuelItemId ?? null) &&
    row.machineCount === entity.machineCount && row.minerCount === entity.minerCount &&
    row.progress === entity.progress && row.utilization === entity.utilization &&
    row.productionRate === entity.productionRate && row.powerFactor === (entity.powerFactor ?? null) &&
    completeInspectorItemRowsMatch(entity.inputs as NumericItemRecord, row.inputItems) &&
    completeInspectorItemRowsMatch(entity.outputs as NumericItemRecord, row.outputItems);
}

function desktopBeltSummaryMatches(belt: BeltConnection, row: SelectedBeltReadModel): boolean {
  return row.beltId === belt.id && row.planetId === belt.planetId &&
    row.sourceEntityId === belt.source && row.targetEntityId === belt.target &&
    row.itemId === belt.itemId && row.lanes === belt.lanes && row.tier === belt.tier &&
    row.sorterTier === belt.sorterTier && row.stackSize === (belt.stackSize ?? null) &&
    row.priority === belt.priority && row.progress === belt.progress && row.lastFlow === belt.lastFlow &&
    row.totalTransferred === (belt.totalTransferred ?? null) && row.congestion === (belt.congestion ?? null);
}

function rawInspectorItemRows(record: NumericItemRecord): Array<readonly [ItemId, number]> {
  return Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => compareInspectorItemIds(left, right))
    .map(([itemId, amount]) => [itemId as ItemId, amount] as const);
}

function readModelInspectorItemRows(
  rows: SelectedEntityReadModel["inputItems"]["rows"],
): Array<readonly [ItemId, number]> {
  return rows.map((row) => [row.itemId as ItemId, row.amount] as const);
}

/**
 * Display-only desktop binding for the bounded atomic factory projection.
 * The App-level bridge owns session/revision/request-order validation. This
 * final component additionally refuses a wrong planet, selection, truncated
 * item ledger or any semantic drift from the full command-authority record.
 */
export function DesktopInspectorLiveSummary({ game, entity, belt, readModel }: {
  game: GameState;
  entity: FactoryEntity | null;
  belt: BeltConnection | null;
  readModel: FactoryInspectorSummaryReadModel;
}) {
  const validSource = readModel.source === "native-core"
    ? Number.isSafeInteger(readModel.revision) && (readModel.revision ?? -1) >= 0
    : readModel.source === "web-game-state" && readModel.revision === null;
  const commonMatch = readModel.schema === "factory-read-model-v1" && validSource &&
    readModel.activePlanetId === game.activePlanetId;
  const displayEntity = commonMatch && entity && !belt && readModel.belt === null && readModel.entity &&
    entity.planetId === game.activePlanetId && desktopEntitySummaryMatches(entity, readModel.entity)
    ? readModel.entity
    : null;
  const displayBelt = commonMatch && !entity && belt && readModel.entity === null && readModel.belt &&
    belt.planetId === game.activePlanetId && desktopBeltSummaryMatches(belt, readModel.belt)
    ? readModel.belt
    : null;
  const source = displayEntity || displayBelt ? readModel.source : "web-game-state";
  const revision = source === "native-core" ? readModel.revision : null;

  if (entity) {
    const progress = displayEntity?.progress ?? entity.progress;
    const utilization = displayEntity?.utilization ?? entity.utilization;
    const productionRate = displayEntity?.productionRate ?? entity.productionRate;
    const powerFactor = displayEntity?.powerFactor ?? entity.powerFactor ?? getEntityPowerFactor(game, entity);
    const inputRows = displayEntity
      ? readModelInspectorItemRows(displayEntity.inputItems.rows)
      : rawInspectorItemRows(entity.inputs as NumericItemRecord);
    const outputRows = displayEntity
      ? readModelInspectorItemRows(displayEntity.outputItems.rows)
      : rawInspectorItemRows(entity.outputs as NumericItemRecord);
    return <section
      className="inspector-content desktop-inspector-live-summary"
      aria-label="实时运行摘要"
      data-factory-read-model-source={source}
      data-factory-read-model-revision={revision ?? "web"}
    >
      <div className="inspector-identity"><i className="building-mark"><Gauge size={18} /></i><div><span>桌面薄读投影</span><strong>实时运行摘要</strong></div></div>
      <dl className="metric-ledger">
        <div><dt>建筑堆叠</dt><dd>×{displayEntity?.machineCount ?? entity.machineCount}</dd></div>
        <div><dt>采集设备</dt><dd>×{displayEntity?.minerCount ?? entity.minerCount}</dd></div>
        <div><dt>周期进度</dt><dd>{Math.round(progress * 100)}%</dd></div>
        <div><dt>当前利用率</dt><dd>{Math.round(utilization * 100)}%</dd></div>
        <div><dt>近期产出</dt><dd>{productionRate.toFixed(1)}/min</dd></div>
        <div><dt>供电系数</dt><dd>{Math.round(powerFactor * 100)}%</dd></div>
        {inputRows.length > 0 ? inputRows.map(([itemId, amount]) => <div key={`input-${itemId}`}><dt>输入 · {getItem(itemId).name}</dt><dd><QuantityValue value={amount} interactive={false} /></dd></div>) : <div><dt>输入缓存</dt><dd>暂无</dd></div>}
        {outputRows.length > 0 ? outputRows.map(([itemId, amount]) => <div key={`output-${itemId}`}><dt>输出 · {getItem(itemId).name}</dt><dd><QuantityValue value={amount} interactive={false} /></dd></div>) : <div><dt>输出缓存</dt><dd>暂无</dd></div>}
      </dl>
    </section>;
  }

  if (belt) {
    const itemId = (displayBelt?.itemId ?? belt.itemId) as ItemId;
    const stackSize = displayBelt?.stackSize ?? belt.stackSize ?? 1;
    const congestion = displayBelt?.congestion ?? belt.congestion ?? 0;
    const totalTransferred = displayBelt?.totalTransferred ?? belt.totalTransferred ?? 0;
    const priority = displayBelt?.priority ?? belt.priority;
    return <section
      className="inspector-content desktop-inspector-live-summary"
      aria-label="实时线路摘要"
      data-factory-read-model-source={source}
      data-factory-read-model-revision={revision ?? "web"}
    >
      <div className="inspector-identity"><ItemMark itemId={itemId} /><div><span>桌面薄读投影</span><strong>{getItem(itemId).name}实时线路摘要</strong></div></div>
      <dl className="metric-ledger">
        <div><dt>传送带等级</dt><dd>Mk.{beltTierRoman((displayBelt?.tier ?? belt.tier) as BeltTier)}</dd></div>
        <div><dt>并行线路</dt><dd>×{displayBelt?.lanes ?? belt.lanes}</dd></div>
        <div><dt>分拣器等级</dt><dd>Mk.{displayBelt?.sorterTier ?? belt.sorterTier}</dd></div>
        <div><dt>近期流量</dt><dd>{(displayBelt?.lastFlow ?? belt.lastFlow).toFixed(2)}/s</dd></div>
        <div><dt>货物堆叠</dt><dd>×{stackSize}</dd></div>
        <div><dt>线路优先级</dt><dd>{priority === 2 ? "高" : priority === 1 ? "标准" : "低"}</dd></div>
        <div><dt>在途进度</dt><dd>{Math.round((displayBelt?.progress ?? belt.progress) * 100)}%</dd></div>
        <div><dt>拥堵指数</dt><dd className={congestion > 0.8 ? "status-text status-text--blocked" : undefined}>{Math.round(congestion * 100)}%</dd></div>
        <div><dt>累计运输</dt><dd><QuantityValue value={totalTransferred} interactive={false} /></dd></div>
      </dl>
    </section>;
  }

  return null;
}

function exactNativeMultiSelectionRows(
  game: GameState,
  entities: readonly FactoryEntity[],
  belts: readonly BeltConnection[],
  readModel: FactoryMultiSelectionSummaryReadModel,
): boolean {
  if (readModel.source !== "native-core" || !Number.isSafeInteger(readModel.revision) ||
    (readModel.revision ?? -1) < 0 || readModel.schema !== "factory-read-model-v1" ||
    readModel.activePlanetId !== game.activePlanetId || readModel.entityRows.truncated ||
    readModel.beltRows.truncated || readModel.requestedEntityCount !== entities.length ||
    readModel.requestedBeltCount !== belts.length ||
    readModel.entityRows.totalCount !== readModel.entityRows.rows.length ||
    readModel.beltRows.totalCount !== readModel.beltRows.rows.length ||
    readModel.entityRows.rows.length !== entities.length || readModel.beltRows.rows.length !== belts.length) {
    return false;
  }
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity] as const));
  const beltsById = new Map(belts.map((belt) => [belt.id, belt] as const));
  if (entitiesById.size !== entities.length || beltsById.size !== belts.length) return false;
  return readModel.entityRows.rows.every((row) => {
    const entity = entitiesById.get(row.entityId);
    return Boolean(entity && row.planetId === game.activePlanetId && row.powerFactor !== null &&
      desktopEntitySummaryMatches(entity, row));
  }) && readModel.beltRows.rows.every((row) => {
    const belt = beltsById.get(row.beltId);
    return Boolean(belt && row.planetId === game.activePlanetId && row.totalTransferred !== null &&
      row.congestion !== null && desktopBeltSummaryMatches(belt, row));
  });
}

function addMultiSelectionItemAmount(totals: Map<ItemId, number>, itemId: string, amount: number): void {
  totals.set(itemId as ItemId, (totals.get(itemId as ItemId) ?? 0) + amount);
}

function sortedMultiSelectionItemTotals(totals: ReadonlyMap<ItemId, number>): Array<readonly [ItemId, number]> {
  return [...totals]
    .filter(([, amount]) => amount !== 0)
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]) || compareInspectorItemIds(left[0], right[0]));
}

/** Pure display aggregate; all multi-select commands keep the full GameState. */
export function DesktopMultiSelectionLiveSummary({ game, entities, belts, readModel }: {
  game: GameState;
  entities: readonly FactoryEntity[];
  belts: readonly BeltConnection[];
  readModel: FactoryMultiSelectionSummaryReadModel;
}) {
  const useNative = exactNativeMultiSelectionRows(game, entities, belts, readModel);
  const source = useNative ? "native-core" : "web-game-state";
  const inputTotals = new Map<ItemId, number>();
  const outputTotals = new Map<ItemId, number>();
  let equipmentCount = 0;
  let entityWeight = 0;
  let weightedProgress = 0;
  let weightedUtilization = 0;
  let weightedPowerFactor = 0;
  let productionRate = 0;

  if (useNative) {
    for (const row of readModel.entityRows.rows) {
      const weight = Math.max(1, row.machineCount + row.minerCount);
      equipmentCount += row.machineCount + row.minerCount;
      entityWeight += weight;
      weightedProgress += row.progress * weight;
      weightedUtilization += row.utilization * weight;
      weightedPowerFactor += row.powerFactor! * weight;
      productionRate += row.productionRate;
      for (const item of row.inputItems.rows) addMultiSelectionItemAmount(inputTotals, item.itemId, item.amount);
      for (const item of row.outputItems.rows) addMultiSelectionItemAmount(outputTotals, item.itemId, item.amount);
    }
  } else {
    for (const entity of entities) {
      const weight = Math.max(1, entity.machineCount + entity.minerCount);
      equipmentCount += entity.machineCount + entity.minerCount;
      entityWeight += weight;
      weightedProgress += entity.progress * weight;
      weightedUtilization += entity.utilization * weight;
      weightedPowerFactor += getEntityPowerFactor(game, entity) * weight;
      productionRate += entity.productionRate;
      for (const [itemId, amount] of rawInspectorItemRows(entity.inputs as NumericItemRecord)) {
        addMultiSelectionItemAmount(inputTotals, itemId, amount);
      }
      for (const [itemId, amount] of rawInspectorItemRows(entity.outputs as NumericItemRecord)) {
        addMultiSelectionItemAmount(outputTotals, itemId, amount);
      }
    }
  }

  let beltFlow = 0;
  let beltCongestion = 0;
  let maxBeltCongestion = 0;
  let beltProgress = 0;
  let beltTransferred = 0;
  let beltStackSize = 0;
  if (useNative) {
    for (const row of readModel.beltRows.rows) {
      beltFlow += row.lastFlow;
      beltCongestion += row.congestion!;
      maxBeltCongestion = Math.max(maxBeltCongestion, row.congestion!);
      beltProgress += row.progress;
      beltTransferred += row.totalTransferred!;
      beltStackSize += row.stackSize ?? 1;
    }
  } else {
    for (const belt of belts) {
      const congestion = belt.congestion ?? 0;
      beltFlow += belt.lastFlow;
      beltCongestion += congestion;
      maxBeltCongestion = Math.max(maxBeltCongestion, congestion);
      beltProgress += belt.progress;
      beltTransferred += belt.totalTransferred ?? 0;
      beltStackSize += belt.stackSize ?? 1;
    }
  }
  const inputRows = sortedMultiSelectionItemTotals(inputTotals);
  const outputRows = sortedMultiSelectionItemTotals(outputTotals);
  const averageProgress = entityWeight > 0 ? weightedProgress / entityWeight : 0;
  const averageUtilization = entityWeight > 0 ? weightedUtilization / entityWeight : 0;
  const averagePowerFactor = entityWeight > 0 ? weightedPowerFactor / entityWeight : 1;
  const beltCount = belts.length;

  return <section
    className="batch-control desktop-multi-selection-live-summary"
    aria-label="选区实时动态摘要"
    data-factory-read-model-source={source}
    data-factory-read-model-revision={useNative ? readModel.revision : "web"}
  >
    <header><Gauge size={14} /><span>选区实时动态</span><strong>{entities.length} 节点 · {beltCount} 线路</strong></header>
    <dl className="metric-ledger">
      <div><dt>设备总数</dt><dd>{equipmentCount}</dd></div>
      <div><dt>平均周期进度</dt><dd>{Math.round(averageProgress * 100)}%</dd></div>
      <div><dt>平均利用率</dt><dd>{Math.round(averageUtilization * 100)}%</dd></div>
      <div><dt>合计近期产出</dt><dd>{productionRate.toFixed(1)}/min</dd></div>
      <div><dt>平均供电系数</dt><dd>{Math.round(averagePowerFactor * 100)}%</dd></div>
      {inputRows.slice(0, 4).map(([itemId, amount]) => <div key={`multi-input-${itemId}`}><dt>输入合计 · {getItem(itemId).name}</dt><dd><QuantityValue value={amount} interactive={false} /></dd></div>)}
      {outputRows.slice(0, 4).map(([itemId, amount]) => <div key={`multi-output-${itemId}`}><dt>输出合计 · {getItem(itemId).name}</dt><dd><QuantityValue value={amount} interactive={false} /></dd></div>)}
      {inputRows.length > 4 ? <div><dt>其余输入物料</dt><dd>{inputRows.length - 4} 种</dd></div> : null}
      {outputRows.length > 4 ? <div><dt>其余输出物料</dt><dd>{outputRows.length - 4} 种</dd></div> : null}
      {beltCount > 0 ? <>
        <div><dt>线路合计流量</dt><dd>{beltFlow.toFixed(2)}/s</dd></div>
        <div><dt>平均线路拥堵</dt><dd>{Math.round(beltCongestion / beltCount * 100)}%</dd></div>
        <div><dt>最高线路拥堵</dt><dd>{Math.round(maxBeltCongestion * 100)}%</dd></div>
        <div><dt>平均在途进度</dt><dd>{Math.round(beltProgress / beltCount * 100)}%</dd></div>
        <div><dt>平均货物堆叠</dt><dd>×{(beltStackSize / beltCount).toFixed(2)}</dd></div>
        <div><dt>线路累计运输</dt><dd><QuantityValue value={beltTransferred} interactive={false} /></dd></div>
      </> : null}
    </dl>
  </section>;
}

function EjectorOrbitTargetControl({ game, entities, onChange, batch = false }: {
  game: GameState;
  entities: FactoryEntity[];
  onChange: (entityIds: string[], orbitId: string) => void;
  batch?: boolean;
}) {
  if (entities.length === 0 || entities.some((entity) => entity.buildingId !== "em_rail_ejector")) return null;
  const systemId = getPlanet(entities[0].planetId).systemId;
  if (entities.some((entity) => getPlanet(entity.planetId).systemId !== systemId)) {
    return <section className="ejector-orbit-control ejector-orbit-control--blocked"><header><Orbit size={14} /><span>太阳帆目标轨道</span></header><p>所选弹射器跨越多个恒星系，请按恒星系分别批量设置。</p></section>;
  }
  const orbits = game.dysonEngineering.orbitsBySystem[systemId] ?? [];
  const targetIds = [...new Set(entities.map((entity) => entity.targetDysonOrbitId ?? ""))];
  const commonTargetId = targetIds.length === 1 ? targetIds[0] : "";
  const locked = entities.some((entity) => entity.interactionLocked);
  const status = entities.length === 1 ? getEjectorOrbitTargetStatus(game, entities[0]) : null;
  const invalidTarget = commonTargetId && !orbits.some((orbit) => orbit.id === commonTargetId) ? commonTargetId : null;
  return <section className={`ejector-orbit-control${status && !status.valid ? " ejector-orbit-control--blocked" : ""}`}>
    <header><Orbit size={14} /><span>{batch ? "批量太阳帆轨道" : "太阳帆目标轨道"}</span><strong>{getPlanetDisplayName(game, entities[0].planetId)}</strong></header>
    <select value={commonTargetId} disabled={locked} onChange={(event) => event.target.value && onChange(entities.map((entity) => entity.id), event.target.value)} aria-label={batch ? "批量选择太阳帆目标轨道" : "选择太阳帆目标轨道"}>
      {!commonTargetId ? <option value="" disabled>多个不同目标</option> : null}
      {invalidTarget ? <option value={invalidTarget}>失效轨道（请重新选择）</option> : null}
      {orbits.map((orbit) => <option value={orbit.id} key={orbit.id}>{orbit.name} · 半径 {orbit.radius.toLocaleString("zh-CN")}</option>)}
    </select>
    <small>{locked ? "所选弹射器已锁定，请先解锁再修改轨道。" : status && !status.valid ? status.reason === "foreign-system" ? "原目标属于其他恒星系，当前已暂停发射。" : "原目标已删除或失效，当前已暂停发射。" : `仅影响所选弹射器；本恒星系共有 ${orbits.length} 条戴森云轨道。`}</small>
  </section>;
}

function MultiSelectionInspector({ game, entities, belts, readModel, onRecipeChange, onEjectorOrbitChange, onInstallSprayCoater, onProliferatorConfiguration }: {
  game: GameState;
  entities: FactoryEntity[];
  belts: BeltConnection[];
  readModel: FactoryMultiSelectionSummaryReadModel;
  onRecipeChange: (entityIds: string[], recipeId: RecipeId) => void;
  onEjectorOrbitChange: (entityIds: string[], orbitId: string) => void;
  onInstallSprayCoater: (entityIds: string[]) => void;
  onProliferatorConfiguration: (entityIds: string[], tier: ProliferatorTier, mode: ProliferatorMode) => void;
}) {
  const ids = new Set(entities.map((entity) => entity.id));
  const equipmentCount = entities.reduce((sum, entity) => sum + entity.machineCount + entity.minerCount, 0);
  const ratedDemand = entities.reduce((sum, entity) => {
    if (entity.kind === "vein" && entity.minerCount > 0) {
      return sum + (getBuilding(getExtractorBuildingId(entity.resourceId!)).powerDemandKw ?? 0) * entity.minerCount;
    }
    return sum + (entity.buildingId ? (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount : 0);
  }, 0);
  const internalLines = game.belts.filter((belt) => ids.has(belt.source) && ids.has(belt.target)).length;
  const running = entities.filter((entity) => getEntityOperatingStatus(game, entity).tone === "running").length;
  const composition = new Map<string, number>();
  for (const entity of entities) {
    const name = entity.kind === "vein" ? ITEMS[entity.resourceId!].name : getBuilding(entity.buildingId!).name;
    composition.set(name, (composition.get(name) ?? 0) + Math.max(entity.machineCount, entity.minerCount, 1));
  }
  const machines = entities.filter((entity) => entity.kind === "machine" && entity.buildingId);
  const commonRecipes = machines.length > 0 ? getRecipesForBuilding(machines[0].buildingId!).filter((recipe) =>
    (!recipe.requiredTechId || isTechnologyCompleted(game, recipe.requiredTechId)) &&
    machines.every((entity) => getRecipesForBuilding(entity.buildingId!).some((candidate) => candidate.id === recipe.id))) : [];
  const commonRecipeId = machines.length > 0 && machines.every((entity) => entity.recipeId === machines[0].recipeId)
    ? machines[0].recipeId
    : "";
  const sprayEligible = machines.filter(isProliferatorEligible);
  const sprayInstalled = sprayEligible.filter((entity) => entity.sprayCoaterInstalled);
  const batchContainsResearch = sprayInstalled.some((entity) => entity.recipeId === "matrix_research");
  const commonTier = sprayInstalled.length > 0 && sprayInstalled.every((entity) => (entity.proliferatorTier ?? 1) === (sprayInstalled[0].proliferatorTier ?? 1))
    ? sprayInstalled[0].proliferatorTier ?? 1
    : 1;
  const commonMode = sprayInstalled.length > 0 && sprayInstalled.every((entity) => (entity.proliferatorMode ?? "normal") === (sprayInstalled[0].proliferatorMode ?? "normal"))
    ? sprayInstalled[0].proliferatorMode ?? "normal"
    : "normal";
  return (
    <div className="inspector-content multi-selection-inspector">
      <div className="inspector-identity"><i className="building-mark"><Layers3 size={18} /></i><div><span>画布多选</span><strong>已选择 {entities.length} 个节点</strong></div></div>
      <DesktopMultiSelectionLiveSummary game={game} entities={entities} belts={belts} readModel={readModel} />
      <dl className="metric-ledger">
        <div><dt>设备总数</dt><dd>{equipmentCount}</dd></div>
        <div><dt>运行节点</dt><dd>{running}/{entities.length}</dd></div>
        <div><dt>内部运输线</dt><dd>{internalLines}</dd></div>
        <div><dt>额定耗电</dt><dd><PowerValue valueKw={ratedDemand} /></dd></div>
      </dl>
      {commonRecipes.length > 0 ? (
        <section className="batch-control">
          <header><Factory size={14} /><span>批量配方</span><strong>{machines.length} 个设备</strong></header>
          <select value={commonRecipeId} onChange={(event) => onRecipeChange(machines.map((entity) => entity.id), event.target.value as RecipeId)} aria-label="批量修改生产配方">
            {!commonRecipeId ? <option value="" disabled>混合配方</option> : null}
            {commonRecipes.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.name}</option>)}
          </select>
        </section>
      ) : null}
      {entities.every((entity) => entity.buildingId === "em_rail_ejector")
        ? <EjectorOrbitTargetControl game={game} entities={entities} onChange={onEjectorOrbitChange} batch />
        : null}
      {sprayEligible.length > 0 ? (
        <section className="batch-control batch-proliferator">
          <header><Sparkles size={14} /><span>批量喷涂</span><strong>{sprayInstalled.length}/{sprayEligible.length}</strong></header>
          {sprayInstalled.length < sprayEligible.length ? (
            <button type="button" disabled={(game.construction.spray_coater ?? 0) < sprayEligible.length - sprayInstalled.length || !isTechnologyCompleted(game, "proliferator_1")} onClick={() => onInstallSprayCoater(sprayEligible.map((entity) => entity.id))}><Wrench size={13} />安装缺少的喷涂机</button>
          ) : null}
          {sprayInstalled.length > 0 ? <div className="batch-proliferator-options">
            <select value={commonTier} onChange={(event) => onProliferatorConfiguration(sprayInstalled.map((entity) => entity.id), Number(event.target.value) as ProliferatorTier, commonMode)} aria-label="批量增产剂等级">
              {([1, 2, 3] as ProliferatorTier[]).map((tier) => <option value={tier} disabled={!isTechnologyCompleted(game, getProliferator(tier).requiredTechId)} key={tier}>Mk.{tier === 3 ? "III" : tier === 2 ? "II" : "I"}</option>)}
            </select>
            <select value={commonMode} onChange={(event) => onProliferatorConfiguration(sprayInstalled.map((entity) => entity.id), commonTier, event.target.value as ProliferatorMode)} aria-label="批量增产模式">
              <option value="normal">正常生产</option><option value="extra" disabled={batchContainsResearch}>额外产出{batchContainsResearch ? "（科研不可用）" : ""}</option><option value="speed">生产加速</option>
            </select>
          </div> : null}
        </section>
      ) : null}
      <section className="selection-composition"><span>选区构成</span><div>{[...composition].map(([name, count]) => <p key={name}><strong>{name}</strong><em>×{count}</em></p>)}</div></section>
    </div>
  );
}

function InspectorEmpty({ game, onOpenTutorial }: { game: GameState; onOpenTutorial?: (sectionId?: string) => void }) {
  const networkStats = useMemo(() => {
    let entityCount = 0;
    let machineCount = 0;
    let beltCount = 0;
    let topConsumerName = "";
    let topConsumerDemand = 0;

    for (const entity of game.entities) {
      if (entity.planetId !== game.activePlanetId) continue;
      entityCount += 1;
      machineCount += entity.machineCount + entity.minerCount;

      if (entity.kind === "vein" && entity.minerCount > 0) {
        const building = getBuilding(getExtractorBuildingId(entity.resourceId!));
        const demand = (building.powerDemandKw ?? 0) * entity.minerCount;
        if (demand > topConsumerDemand) {
          topConsumerName = building.name;
          topConsumerDemand = demand;
        }
      } else if (entity.buildingId) {
        const building = getBuilding(entity.buildingId);
        const demand = (building.powerDemandKw ?? 0) * entity.machineCount;
        if (demand > topConsumerDemand) {
          topConsumerName = building.name;
          topConsumerDemand = demand;
        }
      }
    }
    for (const belt of game.belts) {
      if (belt.planetId === game.activePlanetId) beltCount += 1;
    }
    return { beltCount, entityCount, machineCount, topConsumerDemand, topConsumerName };
  }, [game.activePlanetId, game.belts, game.entities]);
  const reserve = game.metrics.fuelReserveSeconds;
  const reserveLabel = reserve >= 60 ? `${Math.floor(reserve / 60)}m ${Math.floor(reserve % 60)}s` : reserve > 0 ? `${Math.floor(reserve)}s` : "-";
  return (
    <div className="inspector-empty">
      <Layers3 size={24} />
      <strong>行星生产网络</strong>
      <dl>
        <div><dt>生产节点</dt><dd>{networkStats.entityCount}</dd></div>
        <div><dt>已部署设备</dt><dd>{networkStats.machineCount}</dd></div>
        <div><dt>物流连接</dt><dd>{networkStats.beltCount}</dd></div>
        <div><dt>可再生能源</dt><dd><PowerValue valueKw={game.metrics.windGenerationKw + game.metrics.solarGenerationKw + game.metrics.geothermalGenerationKw} /></dd></div>
        <div><dt>射线电力</dt><dd><PowerValue valueKw={game.metrics.rayGenerationKw} /></dd></div>
        <div><dt>戴森球功率</dt><dd><PowerValue valueKw={game.dysonSphere.generationKw} /></dd></div>
        <div><dt>燃料发电</dt><dd><PowerValue valueKw={game.metrics.thermalGenerationKw + game.metrics.fusionGenerationKw + game.metrics.artificialStarGenerationKw} /></dd></div>
        <div><dt>燃料续航</dt><dd>{reserveLabel}</dd></div>
        <div><dt>电网储能</dt><dd>{game.metrics.storedEnergyMj.toFixed(1)} / {game.metrics.storageCapacityMj.toFixed(0)} MJ</dd></div>
        <div><dt>最大耗电设备</dt><dd>{networkStats.topConsumerDemand ? <>{networkStats.topConsumerName} <PowerValue valueKw={networkStats.topConsumerDemand} /></> : "-"}</dd></div>
        <div><dt>运行时间</dt><dd>{Math.floor(game.elapsedSeconds / 60)} min</dd></div>
      </dl>
      {onOpenTutorial ? <button className="inspector-tutorial-link" type="button" onClick={() => onOpenTutorial("troubleshooting")}><BookOpen size={14} />查看常见故障排查教程</button> : null}
    </div>
  );
}

function EquipmentUpgradeControl({ game, entity, onUpgrade }: {
  game: GameState;
  entity: FactoryEntity;
  onUpgrade: (entityId: string) => void;
}) {
  if (!entity.buildingId) return null;
  const targetId = getBuildingUpgradeTarget(entity.buildingId);
  if (!targetId) return null;
  const current = getBuilding(entity.buildingId);
  const target = getBuilding(targetId);
  const definition = getConstructionDefinition(targetId);
  const stock = game.construction[targetId] ?? 0;
  const unlocked = !definition?.requiredTechId || isTechnologyCompleted(game, definition.requiredTechId);
  const ready = canUpgradeEntity(game, entity.id);
  return (
    <section className="equipment-upgrade" data-inspector-section="upgrade" data-inspector-section-label="建筑升级" aria-label="建筑升级">
      <header>
        <span><ArrowUp size={14} />设备升级</span>
        <strong>Mk.{current.tier ?? 1} → Mk.{target.tier ?? 1}</strong>
      </header>
      <dl>
        <div><dt>设备速度</dt><dd>{current.speed.toFixed(2)}× → {target.speed.toFixed(2)}×</dd></div>
        <div><dt>单机耗电</dt><dd><PowerValue valueKw={current.powerDemandKw ?? 0} /> → <PowerValue valueKw={target.powerDemandKw ?? 0} /></dd></div>
        <div><dt>升级设备</dt><dd>{stock}/{entity.machineCount}</dd></div>
      </dl>
      <button type="button" disabled={!ready} onClick={() => onUpgrade(entity.id)} title={unlocked ? `升级为${target.name}` : `需要科技：${getTechnology(definition?.requiredTechId)?.name ?? "未解锁"}`}>
        {unlocked ? <ArrowUp size={14} /> : <LockKeyhole size={14} />}
        {unlocked ? `升级整组 ×${entity.machineCount}` : "科技锁定"}
      </button>
    </section>
  );
}

function ProliferatorControl({ game, entity, onInstall, onRemove, onConfigure }: {
  game: GameState;
  entity: FactoryEntity;
  onInstall: (entityId: string) => void;
  onRemove: (entityId: string) => void;
  onConfigure: (entityId: string, tier: ProliferatorTier, mode: ProliferatorMode) => void;
}) {
  const sprayCapable = entity.kind === "machine" && entity.buildingId !== "spray_coater" &&
    Boolean(entity.buildingId && getRecipesForBuilding(entity.buildingId).some((recipe) => recipe.inputs.length > 0 && recipe.outputs.length > 0));
  if (!sprayCapable) return null;
  const stock = game.construction.spray_coater ?? 0;
  if (!entity.sprayCoaterInstalled) {
    const check = getSprayCoaterInstallCheck(game, entity.id);
    return (
      <section className="proliferator-control proliferator-control--install" data-inspector-section="proliferator" data-inspector-section-label="喷涂配置" aria-label="喷涂配置">
        <header><span><Sparkles size={14} />生产喷涂</span><strong>模块未安装</strong></header>
        <div><span>喷涂机库存</span><strong>{stock}/1</strong></div>
        <p className={check.ready ? "ready" : "warning"}>{check.reason}</p>
        <button type="button" disabled={!check.ready} onClick={() => onInstall(entity.id)} title={check.reason}>
          {check.code === "technology-locked" ? <LockKeyhole size={14} /> : <Wrench size={14} />}{check.ready ? "安装喷涂模块" : "暂不可安装"}
        </button>
      </section>
    );
  }

  const tier = entity.proliferatorTier ?? 1;
  const definition = getProliferator(tier);
  const recipe = getRecipe(entity.recipeId);
  const researchMode = recipe?.id === "matrix_research";
  const availablePoints = Math.floor((entity.proliferatorPoints ?? 0) +
    (entity.inputs[definition.itemId] ?? 0) * definition.sprayPoints);
  const mode = entity.proliferatorMode ?? "normal";
  const modeEffect = mode === "extra"
    ? `额外产出 +${Math.round(getEntityExtraProductBonus(entity) * 1000) / 10}%`
    : mode === "speed"
      ? `生产速度 +${Math.round((getEntityProliferatorSpeedMultiplier(entity) - 1) * 100)}%`
      : "不消耗喷涂点数";
  const removalRefund = getSprayCoaterRemovalRefund(game, entity.id);
  return (
    <section className="proliferator-control" data-inspector-section="proliferator" data-inspector-section-label="喷涂配置" aria-label="喷涂配置">
      <header><span><Sparkles size={14} />生产喷涂</span><strong>{modeEffect}</strong></header>
      <div className="proliferator-tier" aria-label="增产剂等级">
        {([1, 2, 3] as ProliferatorTier[]).map((option) => {
          const optionDefinition = getProliferator(option);
          const unlocked = isTechnologyCompleted(game, optionDefinition.requiredTechId);
          return <button className={tier === option ? "active" : ""} type="button" disabled={!unlocked} key={option} onClick={() => onConfigure(entity.id, option, mode)} title={unlocked ? getItem(optionDefinition.itemId).name : `需要科技：${getTechnology(optionDefinition.requiredTechId)?.name}`}>
            Mk.{option === 3 ? "III" : option === 2 ? "II" : "I"}
          </button>;
        })}
      </div>
      <div className="segmented-control proliferator-mode" aria-label="生产喷涂模式">
        {(["normal", "extra", "speed"] as ProliferatorMode[]).map((option) => (
          <button className={mode === option ? "active" : ""} type="button" key={option} disabled={researchMode && option === "extra"} title={researchMode && option === "extra" ? "科研模式仅支持加速，不提供额外科技进度" : undefined} onClick={() => onConfigure(entity.id, tier, option)}>
            {{ normal: "正常", extra: "增产", speed: "加速" }[option]}
          </button>
        ))}
      </div>
      <dl>
        <div><dt>可用点数</dt><dd>{availablePoints}</dd></div>
        <div><dt>单件点数</dt><dd>{definition.sprayPoints}</dd></div>
        <div><dt>{researchMode ? "每份矩阵消耗" : "每周期消耗"}</dt><dd>{getProliferatorSprayCost(recipe)}</dd></div>
        <div><dt>耗电倍率</dt><dd>{getEntityProliferatorPowerMultiplier(entity).toFixed(2)}×</dd></div>
      </dl>
      <button className="proliferator-remove" type="button" onClick={() => onRemove(entity.id)} title="拆卸后返还喷涂模块和未消耗的增产剂">
        <Trash2 size={14} />拆卸喷涂模块
        <small>返还模块 ×{removalRefund?.sprayCoaters ?? 1}{removalRefund?.proliferatorItemId && removalRefund.proliferatorItems > 0 ? ` · ${ITEMS[removalRefund.proliferatorItemId].name} ×${removalRefund.proliferatorItems}` : ""}</small>
      </button>
    </section>
  );
}

function PowerNetworkControl({ game, entity, onGridChange, onPowerPriorityChange, onGenerationPriorityChange }: {
  game: GameState;
  entity: FactoryEntity;
  onGridChange: (entityId: string, gridId: PowerGridId) => void;
  onPowerPriorityChange: (entityId: string, priority: PowerPriority) => void;
  onGenerationPriorityChange: (entityId: string, priority: PowerPriority) => void;
}) {
  const gridId = entity.powerGridId ?? "grid-a";
  const grid = getPowerGridMetrics(game, entity.planetId, gridId);
  const generator = entity.kind === "power" || entity.buildingId === "ray_receiver";
  const covered = isEntityInPowerCoverage(game, entity);
  const factor = getEntityPowerFactor(game, entity);
  return (
    <section className="power-network-control" data-inspector-section="power" data-inspector-section-label="电力与优先级" aria-label="电力与优先级">
      <header><span><Zap size={14} />电网域</span><strong>{POWER_GRID_LABELS[gridId]}</strong></header>
      <div className="power-grid-switcher" role="group" aria-label="选择电网域">
        {POWER_GRID_IDS.map((option) => <button type="button" key={option} className={gridId === option ? "active" : ""} onClick={() => onGridChange(entity.id, option)}>{POWER_GRID_LABELS[option].slice(0, 1)}</button>)}
      </div>
      <dl className="metric-ledger power-network-ledger">
        <div><dt>供电状态</dt><dd className={covered && factor > 0 ? "status-text--running" : "status-text--blocked"}>{covered ? `${Math.round(factor * 100)}%` : "电网断电"}</dd></div>
        <div><dt>供电范围</dt><dd>全行星</dd></div>
        <div><dt>电网负载</dt><dd><PowerValue valueKw={grid.demandKw} /> / <PowerValue valueKw={grid.generationKw} /></dd></div>
      </dl>
      <div className="power-priority-buttons" role="group" aria-label={generator ? "发电调度优先级" : "用电优先级"}>
        <span>{generator ? "发电调度优先级" : "用电优先级"}</span>
        <div className="segmented-control">{([3, 2, 1] as PowerPriority[]).map((priority) => <button type="button" className={(generator ? entity.generationPriority : entity.powerPriority) === priority ? "active" : ""} key={priority} onClick={() => generator ? onGenerationPriorityChange(entity.id, priority) : onPowerPriorityChange(entity.id, priority)}>{priority === 3 ? "高" : priority === 2 ? "中" : "低"}</button>)}</div>
      </div>
    </section>
  );
}

function EntityManagementActions({ game, entity, onSetTarget, onRemove }: {
  game: GameState;
  entity: FactoryEntity;
  onSetTarget: (entityId: string, target: number) => { ok: boolean; error?: string };
  onRemove: (entityId: string, count?: number) => void;
}) {
  const currentCount = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
  const [targetCountDraft, setTargetCountDraft] = useState(String(Math.max(1, currentCount)));
  const [targetCountError, setTargetCountError] = useState<string | null>(null);
  useEffect(() => {
    setTargetCountDraft(String(Math.max(1, currentCount)));
    setTargetCountError(null);
  }, [currentCount, entity.id]);
  const constructionId = entity.kind === "vein" && entity.resourceId
    ? getExtractorBuildingId(entity.resourceId)
    : entity.buildingId;
  const available = constructionId ? Math.floor(game.construction[constructionId] ?? 0) : 0;
  if (!constructionId) return null;
  const name = getBuilding(constructionId).name;
  const singleEntity = entity.buildingId === "micro_black_hole_connector" || entity.buildingId === "time_warp_device";
  const submitTargetCount = (raw = targetCountDraft) => {
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) {
      setTargetCountError("目标数量必须为正整数");
      return false;
    }
    const target = Number(normalized);
    if (!Number.isSafeInteger(target) || target < 1 || (target > MAX_BUILDING_STACK_COUNT && target >= currentCount)) {
      setTargetCountError(`请输入 1 至 ${MAX_BUILDING_STACK_COUNT.toLocaleString("zh-CN")} 的整数；历史超限数量只允许降低`);
      return false;
    }
    const result = onSetTarget(entity.id, target);
    if (!result.ok) {
      setTargetCountError(result.error ?? "堆叠目标调整失败");
      return false;
    }
    setTargetCountDraft(String(target));
    setTargetCountError(null);
    return true;
  };
  const quickAdjust = (delta: number) => {
    const target = Math.max(1, Math.min(MAX_BUILDING_STACK_COUNT, currentCount + delta));
    setTargetCountDraft(String(target));
    submitTargetCount(String(target));
  };
  const positiveShortcuts = [1, 10, 100, 10_000, 100_000] as const;
  const negativeShortcuts = [1, 10, 100, 10_000, 100_000] as const;
  return (
    <div className={`entity-management-actions${entity.kind === "vein" ? " entity-management-actions--extractor" : ""}`} data-inspector-section="stack" data-inspector-section-label="堆叠与回收" aria-label="堆叠与回收">
      {!singleEntity ? <div className="entity-stack-batch-remove entity-stack-target-control">
        <label><span>堆叠目标</span><input inputMode="numeric" pattern="[0-9]*" min={1} max={Math.max(MAX_BUILDING_STACK_COUNT, currentCount)} value={targetCountDraft} onChange={(event) => { setTargetCountDraft(event.target.value); setTargetCountError(null); }} onBlur={() => submitTargetCount()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitTargetCount(); } else if (event.key === "Escape") { setTargetCountDraft(String(Math.max(1, currentCount))); setTargetCountError(null); } }} aria-label="建筑堆叠目标数量" aria-invalid={Boolean(targetCountError)} /></label>
        <div className="entity-stack-target-shortcuts" aria-label="建筑堆叠快捷调整">
          {positiveShortcuts.map((delta) => {
            const actual = Math.max(0, Math.min(delta, MAX_BUILDING_STACK_COUNT - currentCount));
            return <button type="button" key={`plus-${delta}`} aria-label={`快速增加 ${delta.toLocaleString("zh-CN")} 台建筑，剩余 ${available}`} disabled={actual < 1 || available < actual} onClick={() => quickAdjust(delta)}>+{delta}</button>;
          })}
          {negativeShortcuts.map((delta) => <button type="button" key={`minus-${delta}`} aria-label={`减少 ${delta.toLocaleString("zh-CN")} 台建筑`} disabled={currentCount <= 1} onClick={() => quickAdjust(-delta)}>-{delta}</button>)}
        </div>
        {targetCountError ? <em role="alert">{targetCountError}</em> : <small>当前 ×{currentCount.toLocaleString("zh-CN")} · 托盘 {name} ×{available.toLocaleString("zh-CN")}；增减均一次校验并原子提交。</small>}
      </div> : null}
      {entity.kind === "vein" ? <button className="danger-command extractor-recovery-all" type="button" disabled={entity.minerCount < 1} onClick={() => onRemove(entity.id, entity.minerCount)}><Trash2 size={15} /> 回收全部采矿机 ×{entity.minerCount}</button> : <button className="danger-command" type="button" onClick={() => onRemove(entity.id)}><Trash2 size={15} /> 回收设备</button>}
    </div>
  );
}

function EntityInspector({
  game,
  entity,
  onRecipeChange,
  onEjectorOrbitChange,
  onLogisticsItemChange,
  onMaterialDeliverySlotChange,
  onPickEntityInput,
  onOpenOrbitalStation,
  onOrbitalCargoPortClear,
  onFuelChange,
  onEnergyModeChange,
  onPowerGridChange,
  onPowerPriorityChange,
  onGenerationPriorityChange,
  onStationModeChange,
  onStationVesselAdjust,
  onStationDroneAdjust,
  onStationFleetTarget,
  onStationFleetFill,
  onStationWarperAdjust,
  onStationWarpEnabled,
  onStationWarperAutoRefillChange,
  onStationWarperTargetChange,
  onStationHubChange,
  onStationMinimumLoadChange,
  onStationSlotItemChange,
  onStationSlotModeChange,
  onStationSlotMinimumLoadChange,
  onStationSlotLimitsChange,
  onStationSlotPriorityChange,
  onSplitterModeChange,
  onInstallSprayCoater,
  onRemoveSprayCoater,
  onOpenResourceSettings,
  onProliferatorConfiguration,
  onSetTarget,
  onUpgrade,
  onUpgradeInterstellarStation,
  onQuantumAttachment,
  onOrbitalCollectorQuantumMode,
  onRemove,
  onOpenConstructionCenter,
  onGalacticExporterPausedChange,
  onBlackHolePausedChange,
  onTimeWarpControllerChange,
  onTimeWarpEnabledChange,
  onTimeWarpRequestedMultiplierChange,
  onOpenTutorial,
  galacticActivityStatus,
}: {
  game: GameState;
  entity: FactoryEntity;
  onRecipeChange: (entityId: string, recipeId: RecipeId) => void;
  onEjectorOrbitChange: (entityId: string, orbitId: string) => void;
  onLogisticsItemChange: (entityId: string, itemId: ItemId) => void;
  onMaterialDeliverySlotChange: (entityId: string, slotIndex: number, mode: MaterialDeliverySlotMode, itemId: ItemId | null) => void;
  onPickEntityInput: (entityId: string, itemId: ItemId) => void;
  onOpenOrbitalStation: (tab: "construction" | "contracts") => void;
  onOrbitalCargoPortClear: (entityId: string, portIndex: 0 | 1 | 2 | 3) => void;
  onFuelChange: (entityId: string, itemId: ItemId) => void;
  onEnergyModeChange: (entityId: string, mode: EnergyMode) => void;
  onPowerGridChange: (entityId: string, gridId: PowerGridId) => void;
  onPowerPriorityChange: (entityId: string, priority: PowerPriority) => void;
  onGenerationPriorityChange: (entityId: string, priority: PowerPriority) => void;
  onStationModeChange: (entityId: string, mode: "supply" | "demand") => void;
  onStationVesselAdjust: (entityId: string, delta: number) => void;
  onStationDroneAdjust: (entityId: string, delta: number) => void;
  onStationFleetTarget: (entityId: string, kind: "drone" | "vessel", target: number) => void;
  onStationFleetFill: (entityId: string, kind: "drone" | "vessel") => void;
  onStationWarperAdjust: (entityId: string, delta: number) => void;
  onStationWarpEnabled: (entityId: string, enabled: boolean) => void;
  onStationWarperAutoRefillChange: (entityId: string, enabled: boolean) => void;
  onStationWarperTargetChange: (entityId: string, target: number) => void;
  onStationHubChange: (entityId: string, enabled: boolean, priority: 0 | 1 | 2) => void;
  onStationMinimumLoadChange: (entityId: string, minimumLoad: StationMinimumLoad) => void;
  onStationSlotItemChange: (entityId: string, slotIndex: number, itemId: ItemId | null) => void;
  onStationSlotModeChange: (entityId: string, slotIndex: number, scope: StationLogisticsScope, mode: StationLogisticsMode) => void;
  onStationSlotMinimumLoadChange: (entityId: string, slotIndex: number, minimumLoad: StationMinimumLoad) => void;
  onStationSlotLimitsChange: (entityId: string, slotIndex: number, minStock: number, maxStock: number) => void;
  onStationSlotPriorityChange: (entityId: string, slotIndex: number, priority: 0 | 1 | 2) => void;
  onStationSlotRoutePolicyChange: (entityId: string, slotIndex: number, routePolicy: InterstellarRoutePolicy) => void;
  onStationSlotWarperBudgetChange: (entityId: string, slotIndex: number, warperBudget: number) => void;
  onSplitterModeChange: (entityId: string, mode: "balanced" | "priority") => void;
  onInstallSprayCoater: (entityId: string) => void;
  onRemoveSprayCoater: (entityId: string) => void;
  onOpenResourceSettings: () => void;
  onProliferatorConfiguration: (entityId: string, tier: ProliferatorTier, mode: ProliferatorMode) => void;
  onSetTarget: (entityId: string, target: number) => { ok: boolean; error?: string };
  onUpgrade: (entityId: string) => void;
  onUpgradeInterstellarStation: (entityId: string) => void;
  onQuantumAttachment: (entityId: string) => void;
  onOrbitalCollectorQuantumMode: (entityId: string, enabled: boolean) => void;
  onRemove: (entityId: string, count?: number) => void;
  onOpenConstructionCenter: () => void;
  onGalacticExporterPausedChange: (entityId: string, paused: boolean) => void;
  onBlackHolePausedChange: (entityId: string, paused: boolean, confirmActivation?: boolean) => void;
  onTimeWarpControllerChange: (entityId: string) => void;
  onTimeWarpEnabledChange: (enabled: boolean) => void;
  onTimeWarpRequestedMultiplierChange: (multiplier: number) => void;
  onOpenTutorial?: (sectionId?: string) => void;
  galacticActivityStatus: GalacticActivityPublicStatus | null;
}) {
  const gameDialog = useGameDialog();
  const status = getEntityOperatingStatus(game, entity);
  if (entity.kind === "vein") {
    const item = getItem(entity.resourceId!);
    const extractor = getBuilding(getExtractorBuildingId(entity.resourceId!));
    const reserve = getResourceReserveSnapshot(game, entity)!;
    const sourceLabel = reserve.infinite
      ? entity.resourceId === "water" ? "无限海洋水源" : entity.resourceId === "sulfuric_acid" ? "无限硫酸海洋" : item.kind === "fluid" ? "无限资源涌泉" : "无限资源矿脉"
      : reserve.exhausted ? "资源已枯竭" : item.kind === "fluid" ? "有限资源涌泉" : "有限资源矿脉";
    return (
      <div className="inspector-content">
        <div className="inspector-identity">
          <ItemMark itemId={entity.resourceId!} />
          <div><span>{sourceLabel}</span><strong>{item.name}</strong></div>
        </div>
        <dl className="metric-ledger">
          <div><dt>{extractor.shortName}</dt><dd>×{entity.minerCount}</dd></div>
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>剩余储量</dt><dd>{reserve.infinite ? "无限" : formatQuantityCompact(reserve.remaining ?? 0)}</dd></div>
          <div><dt>初始总量</dt><dd>{reserve.infinite ? "无限" : formatQuantityCompact(reserve.capacity ?? 0)}</dd></div>
          <div><dt>剩余比例</dt><dd className={reserve.exhausted ? "status-text status-text--blocked" : undefined}>{reserve.infinite ? "无限" : `${reserve.remainingPercent}%`}</dd></div>
          <div><dt>自动产出</dt><dd>{entity.productionRate.toFixed(1)}/min</dd></div>
          <div><dt>采矿科技</dt><dd>{getMiningSpeedMultiplier(game).toFixed(2)}×</dd></div>
          <div><dt>输出缓存</dt><dd>{formatQuantityCompact(entity.outputs[entity.resourceId!] ?? 0)}</dd></div>
        </dl>
        {reserve.exhausted ? <button className="resource-mode-shortcut" type="button" onClick={onOpenResourceSettings}><Settings size={15} /><span><strong>矿脉已枯竭</strong><small>前往设置 → 资源模式切换无限矿</small></span><ChevronRight size={16} /></button> : null}
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  const building = getBuilding(entity.buildingId!);

  if (entity.buildingId === "construction_center") {
    const activeTargets = Object.values(game.constructionAutomation.targetStock).filter((target) => (target ?? 0) > 0).length;
    const automation = getConstructionAutomationStatus(game, entity.id);
    return (
      <div className="inspector-content construction-center-inspector">
        <div className="inspector-identity"><i className="building-mark"><Factory size={18} /></i><div><span>巨构自动补给</span><strong>{building.name} ×{entity.machineCount}</strong></div></div>
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>当前阶段</dt><dd>{automation.stage}</dd></div>
          <div><dt>制造进度</dt><dd>{Math.round(automation.progress * 100)}%</dd></div>
          <div><dt>预计剩余</dt><dd>{automation.etaSeconds > 0 ? `${automation.etaSeconds.toFixed(1)} 秒` : "-"}</dd></div>
          <div><dt>当前负载</dt><dd>{Math.round(entity.utilization * 100)}%</dd></div>
          <div><dt>目标项目</dt><dd>{activeTargets}</dd></div>
          <div><dt>累计制造</dt><dd>{game.constructionAutomation.totalCrafted.toLocaleString("zh-CN")}</dd></div>
          <div><dt>任务 WIP</dt><dd>{formatQuantityCompact(automation.wipCount ?? 0)}</dd></div>
          <div><dt>销毁副产物</dt><dd>{formatQuantityCompact(automation.destroyedByproductCount ?? 0)}</dd></div>
          <div><dt>额定耗电</dt><dd><PowerValue valueKw={(building.powerDemandKw ?? 0) * entity.machineCount} /></dd></div>
        </dl>
        <button className="construction-center-open" type="button" onClick={onOpenConstructionCenter}><Factory size={15} />打开建筑制造中心</button>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  if (entity.buildingId === "galactic_material_exporter") {
    const activityItems: readonly ItemId[] = ACTIVITY_MATERIAL_IDS;
    return <div className="inspector-content galactic-exporter-inspector">
      <div className="inspector-identity"><i className="building-mark"><Rocket size={18} /></i><div><span>银河终局工程</span><strong>{building.name}</strong></div></div>
      <dl className="metric-ledger">
        <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
        <div><dt>运行开关</dt><dd>{entity.galacticExporterPaused !== false ? "已暂停" : "交付中"}</dd></div>
        <div><dt>额定耗电</dt><dd><PowerValue valueKw={(building.powerDemandKw ?? 0) * entity.machineCount} /></dd></div>
        <div><dt>累计出口</dt><dd>{formatQuantityCompact(game.endgame.totalExported)}</dd></div>
      </dl>
      <button className="construction-center-open" type="button" onClick={() => onGalacticExporterPausedChange(entity.id, entity.galacticExporterPaused === false)}>{entity.galacticExporterPaused !== false ? <Play size={15} /> : <Pause size={15} />}{entity.galacticExporterPaused !== false ? "恢复物资交付" : "暂停物资交付"}</button>
      <div className="galactic-exporter-inputs">{activityItems.map((itemId) => <div key={itemId}><ItemMark itemId={itemId} /><span>{ITEMS[itemId].name}</span><strong>{formatQuantityCompact(entity.inputs[itemId] ?? 0)}</strong></div>)}</div>
      <GalacticActivityPanel game={game} status={galacticActivityStatus} compact />
      <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
      <p className="inspector-description">{building.description}</p>
      <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
    </div>;
  }

  if (entity.buildingId === "micro_black_hole_connector") {
    const connectedByPort = new Map(game.belts.filter((belt) => belt.target === entity.id && belt.targetPortIndex !== undefined)
      .map((belt) => [belt.targetPortIndex!, belt]));
    const resume = async () => {
      if (!entity.blackHoleActivationConfirmed) {
        if (!await gameDialog.confirm(`即将启动${getPlanetDisplayName(game, entity.planetId)}上的微型黑洞连接装置。输入物资将被永久销毁且无法找回。`, { danger: true, confirmLabel: "继续确认" })) return;
        if (!await gameDialog.confirm("请再次确认：启动后，传送带送入的物资不会进入任何库存，也无法恢复。", { danger: true, confirmLabel: "确认启动" })) return;
        onBlackHolePausedChange(entity.id, false, true);
        return;
      }
      onBlackHolePausedChange(entity.id, false);
    };
    return <div className="inspector-content black-hole-inspector">
      <div className="inspector-identity"><i className="building-mark"><Atom size={18} /></i><div><span>永久物资销毁</span><strong>{building.name}</strong></div></div>
      <p className="black-hole-warning">输入物资将被永久销毁且无法找回。拆除装置会移除本实体的销毁统计。</p>
      <dl className="metric-ledger">
        <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
        <div><dt>启动确认</dt><dd>{entity.blackHoleActivationConfirmed ? "已确认" : "尚未确认"}</dd></div>
        <div><dt>供电需求</dt><dd>无需供电</dd></div>
      </dl>
      <button className="construction-center-open" type="button" onClick={() => entity.blackHolePaused === false
        ? onBlackHolePausedChange(entity.id, true)
        : resume()}>{entity.blackHolePaused === false ? <Pause size={15} /> : <Play size={15} />}{entity.blackHolePaused === false ? "暂停销毁" : "启动微型黑洞"}</button>
      <div className="black-hole-port-list">{([0, 1, 2] as const).map((index) => {
        const port = entity.blackHolePorts?.find((entry) => entry.index === index);
        const belt = connectedByPort.get(index);
        const itemId = belt?.itemId ?? port?.currentItemId;
        return <div key={index}><span>接口 {index + 1}</span><strong>{belt ? `${ITEMS[belt.itemId].name} · 已连接` : itemId ? `${ITEMS[itemId].name} · 等待重连` : "等待连接"}</strong><small>累计销毁 <QuantityValue value={port?.totalDestroyed ?? "0"} /></small></div>;
      })}</div>
      <p className="inspector-description">{building.description}</p>
      <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
    </div>;
  }

  if (entity.buildingId === "time_warp_device") {
    const isController = game.timeWarp.controllerEntityId === entity.id;
    const requestedPowerKw = getTimeWarpRequiredPowerKw(game.timeWarp.requestedMultiplier);
    const downgradeReason = !game.timeWarp.enabled ? "装置未启动"
      : game.timeWarp.effectiveMultiplier >= game.timeWarp.requestedMultiplier ? "无，当前供电满足请求倍率"
        : requestedPowerKw === null ? "请求倍率超出数值安全范围"
          : `当前获得功率仅支持 ${game.timeWarp.effectiveMultiplier}x，${game.timeWarp.requestedMultiplier}x 需要 ${formatPowerKw(requestedPowerKw)}`;
    return <div className="inspector-content time-warp-inspector">
      <div className="inspector-identity"><i className="building-mark"><Gauge size={18} /></i><div><span>全局实时模拟</span><strong>{building.name}</strong></div></div>
      <dl className="metric-ledger">
        <div><dt>控制权</dt><dd>{isController ? "当前主控" : "非主控"}</dd></div>
        <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
        <div><dt>请求倍率</dt><dd>{game.timeWarp.requestedMultiplier}x</dd></div>
        <div><dt>实际倍率</dt><dd>{game.timeWarp.effectiveMultiplier}x</dd></div>
        <div><dt>请求所需功率</dt><dd>{requestedPowerKw === null ? "超出范围" : <PowerValue valueKw={requestedPowerKw} />}</dd></div>
        <div><dt>当前档位需电</dt><dd><PowerValue valueKw={game.timeWarp.requiredPowerKw} /></dd></div>
        <div><dt>获得功率</dt><dd><PowerValue valueKw={game.timeWarp.allocatedPowerKw} /></dd></div>
        <div><dt>自动降档原因</dt><dd className={game.timeWarp.effectiveMultiplier < game.timeWarp.requestedMultiplier ? "status-text status-text--warning" : undefined}>{downgradeReason}</dd></div>
        <div><dt>待处理模拟</dt><dd>{game.timeWarp.pendingSimulationSeconds.toFixed(1)} 秒</dd></div>
      </dl>
      {!isController ? <button className="construction-center-open" type="button" onClick={() => onTimeWarpControllerChange(entity.id)}><Gauge size={15} />设为主控</button> : <>
        <div className="time-warp-stepper" aria-label="时间扭曲请求倍率">
          <button type="button" aria-label="倍率减一" onClick={() => onTimeWarpRequestedMultiplierChange(Math.max(5, game.timeWarp.requestedMultiplier - 1))}>-</button>
          <input type="number" min={5} step={1} value={game.timeWarp.requestedMultiplier} onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isSafeInteger(value) && value >= 5) onTimeWarpRequestedMultiplierChange(value);
          }} />
          <button type="button" aria-label="倍率加一" onClick={() => onTimeWarpRequestedMultiplierChange(game.timeWarp.requestedMultiplier + 1)}>+</button>
        </div>
      <button className="construction-center-open" type="button" onClick={() => onTimeWarpEnabledChange(!game.timeWarp.enabled)}>{game.timeWarp.enabled ? <Pause size={15} /> : <Play size={15} />}{game.timeWarp.enabled ? "纯挂机运行中" : "开始纯挂机"}</button>
      {onOpenTutorial && status.tone !== "running" ? <button className="inspector-tutorial-link" type="button" onClick={() => onOpenTutorial("time-warp")}><BookOpen size={14} />查看时间扭曲教程</button> : null}
      </>}
      <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
      <p className="inspector-description">时间扭曲只有纯挂机模式。开始后会进入独立挂机页面并冻结画布；离线收益与活动时钟始终使用真实时间。高倍率若无法实时追赶会显示模拟积压。</p>
      <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
    </div>;
  }

  const fuelOptions = getFuelItemIdsForBuilding(entity.buildingId!);
  if (fuelOptions.length > 0) {
    const fuelId = entity.fuelItemId;
    const ratedPower = (building.powerGenerationKw ?? 0) * entity.machineCount;
    return (
      <div className="inspector-content">
        <div className="inspector-identity">
          <i className="building-mark building-mark--thermal">{entity.buildingId === "mini_fusion_power_plant" ? <Atom size={18} /> : <Flame size={18} />}</i>
          <div><span>可调度能源设施</span><strong>{building.name} ×{entity.machineCount}</strong></div>
        </div>
        <label className="recipe-select" data-inspector-section="recipe" data-inspector-section-label="配方与主要模式" aria-label="配方与主要模式">
          <span>当前燃料</span>
          <select value={fuelId ?? ""} onChange={(event) => onFuelChange(entity.id, event.target.value as ItemId)}>
            <option value="" disabled>选择燃料</option>
            {fuelOptions.map((itemId) => <option value={itemId} key={itemId}>{ITEMS[itemId].name} · {FUEL_ENERGY_MJ[itemId]} MJ</option>)}
          </select>
        </label>
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>实时出力</dt><dd><PowerValue valueKw={entity.powerOutputKw ?? 0} /></dd></div>
          <div><dt>额定出力</dt><dd><PowerValue valueKw={ratedPower} /></dd></div>
          <div><dt>燃料库存</dt><dd>{fuelId ? formatQuantityCompact(entity.inputs[fuelId] ?? 0) : "-"}</dd></div>
          <div><dt>单件热值</dt><dd>{fuelId ? `${FUEL_ENERGY_MJ[fuelId]} MJ` : "-"}</dd></div>
          <div><dt>反应余能</dt><dd>{(entity.fuelRemainingMj ?? 0).toFixed(2)} MJ</dd></div>
        </dl>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  if (entity.buildingId === "accumulator") {
    const capacity = (building.energyCapacityMj ?? 0) * entity.machineCount;
    const stored = Math.min(capacity, Math.max(0, entity.storedEnergyMj ?? 0));
    const percent = capacity > 0 ? Math.round(stored / capacity * 100) : 0;
    return (
      <div className="inspector-content energy-inspector">
        <div className="inspector-identity">
          <i className="building-mark building-mark--energy"><BatteryFull size={18} /></i>
          <div><span>电网缓冲储能</span><strong>{building.name} ×{entity.machineCount}</strong></div>
        </div>
        <div className="energy-meter" role="progressbar" aria-label="蓄电器储能" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ width: `${percent}%` }} /><span>储能水平</span><strong>{percent}%</strong>
        </div>
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>当前储能</dt><dd>{stored.toFixed(2)} / {capacity.toFixed(0)} MJ</dd></div>
          <div><dt>充电功率</dt><dd><PowerValue valueKw={entity.powerInputKw ?? 0} /></dd></div>
          <div><dt>放电功率</dt><dd><PowerValue valueKw={entity.powerOutputKw ?? 0} /></dd></div>
          <div><dt>最大功率</dt><dd><PowerValue valueKw={(building.powerGenerationKw ?? 0) * entity.machineCount} /></dd></div>
        </dl>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  if (entity.buildingId === "energy_exchanger") {
    const charging = entity.energyMode !== "discharge";
    const inputId: ItemId = charging ? "accumulator" : "charged_accumulator";
    const outputId: ItemId = charging ? "charged_accumulator" : "accumulator";
    const switchingLocked = (entity.storedEnergyMj ?? 0) > 0.0001;
    return (
      <div className="inspector-content energy-inspector">
        <div className="inspector-identity">
          <i className="building-mark building-mark--energy"><BatteryCharging size={18} /></i>
          <div><span>可运输储能设施</span><strong>{building.name} ×{entity.machineCount}</strong></div>
        </div>
        <div className="segmented-control" aria-label="能量枢纽模式">
          <button className={charging ? "active" : ""} type="button" disabled={switchingLocked} onClick={() => onEnergyModeChange(entity.id, "charge")}>充电</button>
          <button className={!charging ? "active" : ""} type="button" disabled={switchingLocked} onClick={() => onEnergyModeChange(entity.id, "discharge")}>放电</button>
        </div>
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>转换方向</dt><dd>{ITEMS[inputId].name} → {ITEMS[outputId].name}</dd></div>
          <div><dt>输入库存</dt><dd>{formatQuantityCompact(entity.inputs[inputId] ?? 0)}</dd></div>
          <div><dt>输出库存</dt><dd>{formatQuantityCompact(entity.outputs[outputId] ?? 0)}</dd></div>
          <div><dt>当前功率</dt><dd><PowerValue valueKw={charging ? -(entity.powerInputKw ?? 0) : entity.powerOutputKw ?? 0} /></dd></div>
          <div><dt>单元能量</dt><dd>90 MJ</dd></div>
        </dl>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        {switchingLocked ? <p className="energy-mode-lock">当前蓄电器周期完成后可切换模式</p> : null}
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  if (entity.kind === "station") {
    const planetary = entity.buildingId === "planetary_logistics_station";
    const interstellar = entity.buildingId === "interstellar_logistics_station";
    const collector = entity.buildingId === "orbital_collector";
    const acceptedItems = collector
      ? Object.entries(getPlanetOrbitalYields(game, entity.planetId))
        .filter(([, rate]) => (rate ?? 0) > 0)
        .map(([itemId]) => ITEMS[itemId as ItemId])
      : Object.values(ITEMS);
    const itemId = entity.storedItemId;
    const collectorQuantumStatus = collector ? getOrbitalCollectorQuantumStatus(game, entity.id) : null;
    const peer = collector ? findInterstellarPeer(game, entity) : planetary ? findPlanetaryPeer(game, entity) : findInterstellarPeer(game, entity);
    if (collector) {
      return (
        <div className="inspector-content station-inspector">
          <div className="inspector-identity">
            <i className="building-mark building-mark--station"><Orbit size={18} /></i>
            <div><span>气态巨星轨道设施</span><strong>{building.name} ×{entity.machineCount}</strong></div>
          </div>
          <div className="recipe-select" data-inspector-section="recipe" data-inspector-section-label="配方与主要模式" aria-label="配方与主要模式">
            <span>采集资源</span>
            <ItemCatalogPicker value={itemId} items={acceptedItems} label="选择采集资源" onChange={(nextItemId) => { if (nextItemId) onLogisticsItemChange(entity.id, nextItemId); }} />
          </div>
          <dl className="metric-ledger">
            <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
            <div><dt>需求目标</dt><dd>{peer ? `${getPlanetDisplayName(game, peer.planetId)} · ${peer.id}` : "等待星际需求"}</dd></div>
            <div><dt>可用库存</dt><dd>{itemId ? formatQuantityCompact(entity.outputs[itemId] ?? 0) : "-"}</dd></div>
            <div><dt>采集周期</dt><dd>{Math.floor(entity.progress * 100)}%</dd></div>
            <div><dt>采集速率</dt><dd>{entity.productionRate.toFixed(1)}/min</dd></div>
            <div><dt>完成航次</dt><dd>{entity.stationTrips ?? 0}</dd></div>
          </dl>
          <section className="station-upgrade-control quantum-network-control" aria-label="量子采集网络接入">
            <header><Atom size={15} /><span>量子采集网络</span><strong>{collectorQuantumStatus?.mode === "quantum" ? "已接入" : collectorQuantumStatus?.mode === "transitioning" ? "交接中" : "传统模式"}</strong></header>
            <p className={`station-upgrade-status station-upgrade-status--${collectorQuantumStatus?.mode === "quantum" ? "ready" : collectorQuantumStatus?.mode === "transitioning" ? "pending" : "idle"}`}>
              {collectorQuantumStatus?.mode === "quantum"
                ? "只向共享库存上传当前采集气体，送达时直接入池，不受量子上传带宽限制。"
                : collectorQuantumStatus?.mode === "transitioning"
                  ? `等待传统航线尾货完成 · ${collectorQuantumStatus.bridgeCount} 条在途`
                  : collectorQuantumStatus?.blocker === "technology" ? "需要先研究“量子物流网络”" : "接入前继续使用传统星际物流。"}
            </p>
            <button
              className="station-upgrade-button"
              type="button"
              disabled={entity.interactionLocked || collectorQuantumStatus?.mode === "transitioning" || collectorQuantumStatus?.blocker === "technology"}
              onClick={() => onOrbitalCollectorQuantumMode(entity.id, collectorQuantumStatus?.mode !== "quantum")}
            ><Atom size={15} />{collectorQuantumStatus?.mode === "quantum" ? "关闭量子采集" : "接入量子采集网络"}</button>
          </section>
          <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
          <p className="inspector-description">{building.description}</p>
          <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
        </div>
      );
    }
    const slots = getStationSlots(entity);
    const configuredItems = new Set(slots.flatMap((slot) => slot.itemId ? [slot.itemId] : []));
    const droneCapacity = getStationDroneCapacity(entity);
    const droneCount = Math.min(droneCapacity, Math.max(0, Math.floor(entity.stationDrones ?? 0)));
    const availableDrones = Math.max(0, Math.floor(game.portableFleet?.logistics_drone ?? 0));
    const vesselCapacity = getStationVesselCapacity(entity);
    const vesselCount = Math.min(vesselCapacity, Math.max(0, Math.floor(entity.stationVessels ?? 0)));
    const availableVessels = Math.max(0, Math.floor(game.portableFleet?.logistics_vessel ?? 0));
    const warperCapacity = getStationWarperCapacity(entity);
    const warperCount = Math.max(0, Math.floor(entity.stationWarpers ?? 0));
    const stationPlanetTray = entity.planetId === game.activePlanetId ? game.tray : game.planetTrays[entity.planetId] ?? {};
    const availableWarpers = Math.max(0, Math.floor(stationPlanetTray.space_warper ?? 0));
    const warpUnlocked = isTechnologyCompleted(game, "space_warp");
    const warperAutoRefill = Boolean(entity.stationWarperAutoRefill);
    const warperTarget = getStationWarperAutoRefillTarget(entity);
    const warperRefill = getStationWarperRefillSnapshot(game, entity.id);
    const warperAutoStatus = warperRefill?.blocker === "technology-locked"
      ? { tone: "blocked", label: "空间翘曲科技未解锁" }
      : warperRefill?.blocker === "disabled"
        ? { tone: "idle", label: "自动补充已关闭" }
        : warperRefill?.blocker === "capacity-full"
          ? { tone: "ready", label: `专用仓已满 · ${warperCount}/${warperCapacity}` }
          : warperRefill?.blocker === "target-met"
            ? { tone: "ready", label: `目标库存已满足 · ${warperCount}/${warperTarget}` }
            : warperRefill?.blocker === "stock-empty"
              ? { tone: "blocked", label: "塔内物流槽与本星球托盘均缺少空间翘曲器" }
              : { tone: "pending", label: `可补充 ${Math.min(warperTarget - warperCount, (warperRefill?.inputAvailable ?? 0) + (warperRefill?.outputAvailable ?? 0) + availableWarpers)} 个` };
    const activeRoutes = getStationActiveRoutes(game, entity.id);
    const fleetDiagnostic = getStationFleetDiagnostic(game, entity.id);
    const busyDrones = getStationBusyVehicleCount(game, entity.id, "local");
    const busyVessels = getStationBusyVehicleCount(game, entity.id, "remote");
    const primarySlotIndex = Math.max(0, slots.findIndex((slot) => slot.itemId));
    const primarySlot = slots[primarySlotIndex];
    const primaryScope: StationLogisticsScope = planetary ? "local" : "remote";
    const primaryUnitCargo = planetary ? getPlanetaryCargoCapacity(game) : getInterstellarCargoCapacity(game);
    const primaryVehicleUnit = planetary ? "架" : "船";
    const primaryRouteSeconds = planetary
      ? getPlanetaryTripSeconds(game)
      : getInterstellarTripSeconds(game, Boolean(peer && stationRouteRequiresWarp(entity, peer)));
    const upgradeStatus = interstellar ? getInterstellarStationUpgradeStatus(game, entity.id) : null;
    const quantumStatus = interstellar ? getQuantumAttachmentStatus(game, entity.id) : null;
    return (
      <div className="inspector-content station-inspector">
        <div className="inspector-identity">
          <i className="building-mark building-mark--station"><Orbit size={18} /></i>
          <div><span>{planetary ? "行星多槽调度" : "本地与星际联合调度"}</span><strong>{building.name} ×{entity.machineCount}</strong></div>
        </div>
        {interstellar ? <section className="station-upgrade-control" aria-label="星际物流站升级">
          <header><Sparkles size={15} /><span>物流站等级</span><strong>{entity.stationTier === 2 ? "Mk.II" : "Mk.I"}</strong></header>
          {entity.stationTier === 2 ? <p className="station-upgrade-status station-upgrade-status--ready">已是 Mk.II，传统航线与电梯模式可在此切换。</p> : <>
            <p className={`station-upgrade-status station-upgrade-status--${upgradeStatus?.blocker ?? "invalid"}`}>{upgradeStatus?.reason}</p>
            {upgradeStatus && Object.keys(upgradeStatus.costs).length > 0 ? <div className="station-upgrade-costs">{Object.entries(upgradeStatus.costs).map(([itemId, amount]) => <span key={itemId}><em>{getItem(itemId as ItemId).name}</em><strong>{formatQuantityCompact(game.planetTrays[entity.planetId]?.[itemId as ItemId] ?? 0)} / {formatQuantityCompact(amount)}</strong></span>)}</div> : null}
            <button className="station-upgrade-button" type="button" onClick={() => onUpgradeInterstellarStation(entity.id)}><Sparkles size={15} />升级 Mk.II</button>
          </>}
        </section> : null}
        {interstellar && entity.stationTier === 2 ? <section className="station-upgrade-control quantum-network-control" aria-label="量子物流网络接入">
          <header><Atom size={15} /><span>量子物流网络</span><strong>{quantumStatus?.mode === "quantum" ? "已接入" : quantumStatus?.mode === "transitioning" ? "交接中" : "传统模式"}</strong></header>
          <p className={`station-upgrade-status station-upgrade-status--${quantumStatus?.mode === "quantum" ? "ready" : quantumStatus?.mode === "transitioning" ? "pending" : "idle"}`}>
            {quantumStatus?.mode === "quantum"
              ? "星际槽访问共享池；本地供需继续使用运输机，运输船与翘曲器保持停用。"
              : quantumStatus?.mode === "transitioning"
                ? `仅等待旧星际航线尾货 · ${quantumStatus.bridgeCount} 条桥接；本地运输机不中断。`
                : "升级与接入是两个独立动作；接入前传统航线继续运行。"}
          </p>
          {quantumStatus?.mode !== "quantum" && quantumStatus?.mode !== "transitioning" ? <button className="station-upgrade-button" type="button" disabled={entity.interactionLocked} onClick={() => onQuantumAttachment(entity.id)}><Atom size={15} />接入量子网络</button> : null}
        </section> : null}
        <section className="station-fleet-grid">
          <div className={planetary ? "station-fleet-control" : "station-local-fleet-control"}>
            <div className="station-control-heading"><span>运输机泊位</span><small>随身 {availableDrones}</small></div>
            <div className="station-fleet-summary"><Orbit size={15} /><strong>{droneCount} / {droneCapacity}</strong><small>执行中 {busyDrones}</small></div>
            <QuantityStepper value={droneCount} min={busyDrones} max={droneCapacity} label="物流运输机目标" maxLabel="一键填满" onChange={(target) => onStationFleetTarget(entity.id, "drone", target)} />
          </div>
          {!planetary ? <div className="station-fleet-control">
            <div className="station-control-heading"><span>运输船泊位</span><small>随身 {availableVessels}</small></div>
            <div className="station-fleet-summary"><Rocket size={15} /><strong>{vesselCount} / {vesselCapacity}</strong><small>执行中 {busyVessels}</small></div>
            <QuantityStepper value={vesselCount} min={busyVessels} max={vesselCapacity} label="物流运输船目标" maxLabel="一键填满" onChange={(target) => onStationFleetTarget(entity.id, "vessel", target)} />
          </div> : null}
        </section>
        {fleetDiagnostic ? <section className="station-fleet-diagnostic" aria-label="物流舰队诊断">
          <div><strong>运输机</strong><span>安装 {fleetDiagnostic.drones.installed}/{fleetDiagnostic.drones.capacity}</span><span>忙碌 {fleetDiagnostic.drones.busy}</span><span>可用 {fleetDiagnostic.drones.available}</span><span className={fleetDiagnostic.drones.blocked > 0 ? "warning" : ""}>受阻 {fleetDiagnostic.drones.blocked}</span><small>{fleetDiagnostic.drones.blockerLabel}{fleetDiagnostic.drones.affectedSlotIndices.length ? ` · 槽 ${fleetDiagnostic.drones.affectedSlotIndices.map((index) => index + 1).join("、")}` : ""}</small></div>
          {!planetary ? <div><strong>运输船</strong><span>安装 {fleetDiagnostic.vessels.installed}/{fleetDiagnostic.vessels.capacity}</span><span>忙碌 {fleetDiagnostic.vessels.busy}</span><span>可用 {fleetDiagnostic.vessels.available}</span><span className={fleetDiagnostic.vessels.blocked > 0 ? "warning" : ""}>受阻 {fleetDiagnostic.vessels.blocked}</span><small>{fleetDiagnostic.vessels.blockerLabel}{fleetDiagnostic.vessels.affectedSlotIndices.length ? ` · 槽 ${fleetDiagnostic.vessels.affectedSlotIndices.map((index) => index + 1).join("、")}` : ""}</small></div> : null}
        </section> : null}
        {!planetary ? <div className="station-warper-control">
          <label className="toggle-row">
            <input type="checkbox" checked={entity.stationWarpEnabled !== false} disabled={!warpUnlocked} onChange={(event) => onStationWarpEnabled(entity.id, event.target.checked)} />
            <span>{warpUnlocked ? "允许跨恒星翘曲" : "空间翘曲科技未解锁"}</span>
          </label>
            <div className="station-control-heading"><span>专用翘曲器仓</span><small>{warperCount}/{warperTarget}/{warperCapacity}</small></div>
          <div className="station-fleet-stepper">
            <button type="button" aria-label="卸载 1 个空间翘曲器" disabled={warperCount < 1} onClick={() => onStationWarperAdjust(entity.id, -1)}><Minus size={15} /></button>
            <strong><Sparkles size={15} /> {warperCount} / {warperCapacity}</strong>
            <button type="button" aria-label="装载 1 个空间翘曲器" disabled={!warpUnlocked || availableWarpers < 1 || warperCount >= warperCapacity} onClick={() => onStationWarperAdjust(entity.id, 1)}><Plus size={15} /></button>
          </div>
          <div className="station-warper-auto">
            <label className="toggle-row">
              <input type="checkbox" checked={warperAutoRefill} disabled={!warpUnlocked} onChange={(event) => onStationWarperAutoRefillChange(entity.id, event.target.checked)} />
              <span>自动补充专用翘曲器仓</span>
            </label>
            <label className="station-warper-target"><span>目标库存</span><input type="number" min={1} max={warperCapacity} disabled={!warpUnlocked} defaultValue={warperTarget} key={`${entity.id}-${warperTarget}-${warperCapacity}`} onBlur={(event) => onStationWarperTargetChange(entity.id, Number(event.target.value))} /></label>
            <p className={`station-warper-auto__status station-warper-auto__status--${warperAutoStatus.tone}`}>{warperAutoStatus.label}</p>
            <dl className="station-warper-sources"><div><dt>塔内输入</dt><dd>{warperRefill?.inputAvailable ?? 0}</dd></div><div><dt>塔内输出</dt><dd>{warperRefill?.outputAvailable ?? 0}<small> / 存 {warperRefill?.outputStored ?? 0} · 预留 {warperRefill?.outputReserved ?? 0}</small></dd></div><div><dt>本星球托盘</dt><dd>{availableWarpers}</dd></div></dl>
            <small className="station-warper-help">优先使用塔内输入和未预留输出，其次使用本星球物资托盘。</small>
          </div>
          <div className="station-hub-control">
            <label className="toggle-row">
              <input type="checkbox" checked={Boolean(entity.stationHubEnabled)} onChange={(event) => onStationHubChange(entity.id, event.target.checked, entity.stationHubPriority ?? 1)} />
              <span>中转物流枢纽</span>
            </label>
            <label><span>枢纽优先级</span><select disabled={!entity.stationHubEnabled} value={entity.stationHubPriority ?? 1} onChange={(event) => onStationHubChange(entity.id, true, Number(event.target.value) as 0 | 1 | 2)}><option value={2}>高</option><option value={1}>标准</option><option value={0}>低</option></select></label>
          </div>
        </div> : null}
        <section className="station-slot-list" aria-label="物流站货物槽位">
          {slots.map((slot, slotIndex) => {
            const routes = activeRoutes.filter((route) => route.itemId === slot.itemId);
            const routeProgress = routes.length ? Math.max(...routes.map((route) => route.progress)) : 0;
            return (
              <article className={`station-slot${slot.itemId ? " station-slot--configured" : ""}`} data-station-slot-index={slotIndex} key={slotIndex}>
                <header><span>槽位 {slotIndex + 1}</span>{routes.length ? <strong><Route size={12} />{routes.length} 条在途</strong> : <small>空闲</small>}</header>
                <div className="station-slot-primary">
                  <ItemCatalogPicker value={slot.itemId} items={acceptedItems} disabledIds={configuredItems} allowClear label={`选择槽位 ${slotIndex + 1} 物资`} onChange={(nextItemId) => onStationSlotItemChange(entity.id, slotIndex, nextItemId)} />
                  <span className="station-slot-input">输入 <strong>{slot.itemId ? formatQuantityCompact(entity.inputs[slot.itemId] ?? 0) : "-"}</strong></span>
                  <span className="station-slot-stock">库存 <strong>{slot.itemId ? formatQuantityCompact(entity.outputs[slot.itemId] ?? 0) : "-"}</strong> / {slot.itemId ? formatQuantityCompact(getStationSlotCapacity(game, entity, slot)) : "-"}</span>
                </div>
                {slot.itemId ? <>
                  <div className="station-slot-scope"><span>本地</span><div className="segmented-control">
                    {(["supply", "demand", "storage"] as StationLogisticsMode[]).map((mode) => <button className={slot.localMode === mode ? "active" : ""} type="button" aria-pressed={slot.localMode === mode} key={mode} onClick={() => onStationSlotModeChange(entity.id, slotIndex, "local", mode)}>{{ supply: "供应", demand: "需求", storage: "仓储" }[mode]}</button>)}
                  </div></div>
                  {!planetary ? <div className="station-slot-scope"><span>星际</span><div className="segmented-control">
                    {(["supply", "demand", "storage"] as StationLogisticsMode[]).map((mode) => <button className={slot.remoteMode === mode ? "active" : ""} type="button" aria-pressed={slot.remoteMode === mode} key={mode} onClick={() => onStationSlotModeChange(entity.id, slotIndex, "remote", mode)}>{{ supply: "供应", demand: "需求", storage: "仓储" }[mode]}</button>)}
                  </div></div> : null}
                  <div className="station-slot-load"><span>起运</span><div className="segmented-control">{([0.1, 0.25, 0.5, 1] as StationMinimumLoad[]).map((load) => <button className={slot.minimumLoad === load ? "active" : ""} type="button" aria-pressed={slot.minimumLoad === load} key={load} onClick={() => onStationSlotMinimumLoadChange(entity.id, slotIndex, load)}>{Math.round(load * 100)}%</button>)}</div></div>
                  <div className="station-slot-options">
                    <label><span>优先级</span><select aria-label={`槽位 ${slotIndex + 1} 优先级`} value={slot.priority} onChange={(event) => onStationSlotPriorityChange(entity.id, slotIndex, Number(event.target.value) as 0 | 1 | 2)}><option value={2}>高</option><option value={1}>标准</option><option value={0}>低</option></select></label>
                    <label><span>上限</span><input aria-label={`槽位 ${slotIndex + 1} 库存上限`} type="number" min={0} max={100_000_000} step={1} placeholder="额定" defaultValue={slot.maxStock || ""} key={`max-${slot.itemId}-${slot.maxStock}`} onBlur={(event) => onStationSlotLimitsChange(entity.id, slotIndex, slot.minStock, Number(event.target.value))} /></label>
                  </div>
                  {routes.length ? <div className="station-route-progress"><i><b style={{ width: `${Math.min(100, routeProgress * 100)}%` }} /></i><span>{Math.floor(routeProgress * 100)}%</span><strong>{routes.reduce((sum, route) => sum + route.cargo, 0)} 件在途</strong></div> : null}
                </> : null}
              </article>
            );
          })}
        </section>
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>已配置槽位</dt><dd>{configuredItems.size} / 5</dd></div>
          <div><dt>航线目标</dt><dd>{peer ? planetary ? peer.id : getPlanetDisplayName(game, peer.planetId) : "未配对"}</dd></div>
          <div><dt>在途航线</dt><dd>{activeRoutes.length}</dd></div>
          <div><dt>线路拥堵</dt><dd>{Math.round((entity.stationCongestion ?? 0) * 100)}%</dd></div>
          <div><dt>单机载荷</dt><dd>{primaryUnitCargo} 件/{primaryVehicleUnit}</dd></div>
          <div><dt>最低启航货量</dt><dd>{primarySlot?.itemId ? getStationMinimumCargo(game, entity, primarySlotIndex, primaryScope) : primaryUnitCargo} 件/{primaryVehicleUnit}</dd></div>
          <div><dt>额定航程</dt><dd>{primaryRouteSeconds.toFixed(1)} 秒</dd></div>
          <div><dt>本地载荷</dt><dd>{getPlanetaryCargoCapacity(game)} 件/架 · {getPlanetaryTripSeconds(game).toFixed(1)} 秒</dd></div>
          {!planetary ? <div><dt>星际载荷</dt><dd>{getInterstellarCargoCapacity(game)} 件/船</dd></div> : null}
          {!planetary ? <div><dt>航线类型</dt><dd>{peer && stationRouteRequiresWarp(entity, peer) ? "跨恒星 · 需翘曲" : "恒星系内"}</dd></div> : null}
          <div><dt>完成航次</dt><dd>{entity.stationTrips ?? 0}</dd></div>
          <div><dt>最近运量</dt><dd>{entity.stationLastTransfer ?? 0}</dd></div>
          <div><dt>额定耗电</dt><dd><PowerValue valueKw={(building.powerDemandKw ?? 0) * entity.machineCount} /></dd></div>
        </dl>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  if (entity.kind === "storage" || entity.kind === "splitter") {
    if (entity.buildingId === "orbital_cargo_terminal") {
      const ports = getOrbitalCargoPortItems(entity);
      const binding = entity.orbitalCargoBinding;
      const contract = binding?.kind === "contract"
        ? game.orbitalStation.contractBoard.accepted.find((candidate) => candidate.id === binding.contractId)
        : null;
      const bindingLabel = binding?.kind === "construction"
        ? "当前空间站建设阶段"
        : contract ? contract.title : "未绑定";
      return (
        <div className="inspector-content orbital-cargo-inspector">
          <div className="inspector-identity"><i className="building-mark"><Satellite size={18} /></i><div><span>全星系空间站上传</span><strong>{building.name}</strong></div></div>
          <section className="delivery-hub-slots" aria-label="轨道货运终端接口">
            {ports.map((itemId, index) => {
              const cached = itemId ? Math.max(0, Math.floor(entity.inputs[itemId] ?? 0)) : 0;
              const cargoCompatible = !game.cargo || game.cargo.itemId === itemId && game.cargo.amount < 100;
              return <article className={`${itemId ? "configured" : ""} delivery-hub-slot`} key={index}>
              <header><strong>上传口 {index + 1}</strong><small>{itemId ? ITEMS[itemId].name : "等待线路自动识别"}</small></header>
              <div className="station-slot-primary"><span className="station-slot-input">缓存 <strong>{itemId ? formatQuantityCompact(cached) : "-"}</strong></span><span className="station-slot-stock">线路 <strong>{game.belts.filter((belt) => belt.target === entity.id && belt.targetPortIndex === index).length}</strong></span></div>
              {itemId ? <div className="orbital-cargo-port-actions"><button type="button" disabled={cached < 1 || !cargoCompatible} onClick={() => onPickEntityInput(entity.id, itemId)} title={!cargoCompatible ? "请先放下光标中携带的其他物资" : `取回最多 100 件${ITEMS[itemId].name}`}><PackageOpen size={13} />取回缓存</button><button type="button" onClick={() => onOrbitalCargoPortClear(entity.id, index as 0 | 1 | 2 | 3)} title="安全返还缓存和传送带后释放该接口"><RotateCcw size={13} />清空接口</button></div> : null}
            </article>;
            })}
          </section>
          <dl className="metric-ledger">
            <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
            <div><dt>绑定目标</dt><dd>{bindingLabel}</dd></div>
            <div><dt>最近上传</dt><dd>{entity.productionRate.toFixed(1)}/min</dd></div>
            <div><dt>累计上传</dt><dd>{formatQuantityCompact(entity.orbitalCargoTotalUploaded ?? "0")}</dd></div>
            <div><dt>额定耗电</dt><dd><PowerValue valueKw={(building.powerDemandKw ?? 0) * entity.machineCount} /></dd></div>
          </dl>
          <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
          <button className="construction-center-open" type="button" onClick={() => onOpenOrbitalStation(binding?.kind === "contract" ? "contracts" : "construction")}><Satellite size={15} />{binding?.kind === "contract" ? "打开对应空间站合同" : "打开空间站货运管理"}</button>
          <p className="inspector-description">绑定目标请在全星系空间站工作区管理。解除或切换绑定不会清空这里的缓存；可从接口取回物资，拆除时剩余缓存会保护性返还到本行星托盘。</p>
          <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
        </div>
      );
    }
    if (entity.buildingId === "material_delivery_hub") {
      const deliveryItems = getMaterialDeliveryItems(entity);
      const deliverySlots = getMaterialDeliverySlots(entity);
      const acceptedItems = Object.values(ITEMS).filter((item) => {
        const accepts = building.accepts ?? "any";
        return accepts === "any" || accepts === item.kind || (accepts === "solid" && item.kind === "matrix");
      });
      return (
        <div className="inspector-content delivery-hub-inspector">
          <div className="inspector-identity"><i className="building-mark"><Database size={18} /></i><div><span>物资托盘直送</span><strong>{building.name} ×{entity.machineCount}</strong></div></div>
          <section className="delivery-hub-slots" aria-label="物资配送接口">
            {deliverySlots.map((slot, index) => {
              const connected = game.belts.filter((belt) => belt.target === entity.id && belt.targetPortIndex === index).length;
              return <article className={`${slot.itemId ? "configured" : ""} delivery-hub-slot delivery-hub-slot--${slot.mode}`} key={index}>
                <header><strong>接口 {index + 1}</strong><small>{slot.mode === "manual" ? "指定物资" : slot.mode === "disabled" ? "已清空" : slot.itemId ? "自动识别已绑定" : "等待自动识别"} · {connected} 条线路</small></header>
                <ItemCatalogPicker value={slot.itemId ?? undefined} items={acceptedItems} label={`接口 ${index + 1} 指定物资`} onChange={(nextItemId) => { if (nextItemId) onMaterialDeliverySlotChange(entity.id, index, "manual", nextItemId); }} />
                <div className="delivery-hub-slot-actions">
                  <button className={slot.mode === "auto" ? "active" : ""} type="button" onClick={() => onMaterialDeliverySlotChange(entity.id, index, "auto", null)}>恢复自动识别</button>
                  <button className={slot.mode === "disabled" ? "danger active" : "danger"} type="button" onClick={() => onMaterialDeliverySlotChange(entity.id, index, "disabled", null)}>清空接口</button>
                </div>
              </article>;
            })}
          </section>
          <dl className="metric-ledger">
            <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
            <div><dt>已配置接口</dt><dd>{deliveryItems.length} / {MATERIAL_DELIVERY_SLOT_COUNT}</dd></div>
            <div><dt>最近直送速率</dt><dd>{entity.productionRate.toFixed(1)}/min</dd></div>
          <div><dt>投递位置</dt><dd>{getPlanetDisplayName(game, entity.planetId)}物资托盘</dd></div>
          </dl>
          <p className="inspector-description">每个接口可独立指定、恢复自动识别或清空。重置已连接接口前会要求确认，送达物品直接进入本行星物资托盘。</p>
          <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
        </div>
      );
    }
    const acceptedItems = Object.values(ITEMS).filter((item) => {
      const accepts = building.accepts ?? "any";
      return accepts === "any" || accepts === item.kind || (accepts === "solid" && item.kind === "matrix");
    });
    const itemId = entity.storedItemId;
    return (
      <div className="inspector-content">
        <div className="inspector-identity">
          <i className="building-mark">{entity.kind === "splitter" ? <GitFork size={18} /> : <Database size={18} />}</i>
          <div><span>{entity.kind === "splitter" ? "物流分配设施" : "物流缓存设施"}</span><strong>{building.name} ×{entity.machineCount}</strong></div>
        </div>
        <div className="recipe-select" data-inspector-section="recipe" data-inspector-section-label="配方与主要模式" aria-label="配方与主要模式">
          <span>缓存物品</span>
          <ItemCatalogPicker value={itemId} items={acceptedItems} label="选择缓存物品" onChange={(nextItemId) => { if (nextItemId) onLogisticsItemChange(entity.id, nextItemId); }} />
        </div>
        {entity.kind === "splitter" ? (
          <div className="segmented-control" aria-label="分流模式">
            <button className={entity.distributionMode !== "priority" ? "active" : ""} type="button" onClick={() => onSplitterModeChange(entity.id, "balanced")}>均衡</button>
            <button className={entity.distributionMode === "priority" ? "active" : ""} type="button" onClick={() => onSplitterModeChange(entity.id, "priority")}>优先线路</button>
          </div>
        ) : null}
        <dl className="metric-ledger">
          <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
          <div><dt>输入缓存</dt><dd>{itemId ? formatQuantityCompact(entity.inputs[itemId] ?? 0) : "-"}</dd></div>
          <div><dt>可用库存</dt><dd>{itemId ? formatQuantityCompact(entity.outputs[itemId] ?? 0) : "-"}</dd></div>
          <div><dt>容量上限</dt><dd>{getEntityOutputCapacity(game, entity)}</dd></div>
        </dl>
        <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
        <p className="inspector-description">{building.description}</p>
        <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
      </div>
    );
  }

  const recipe = getRecipe(entity.recipeId);
  const recipeOptions = getRecipesForBuilding(entity.buildingId!).filter((option) =>
    !option.requiredTechId || isTechnologyCompleted(game, option.requiredTechId));
  const railEjector = entity.buildingId === "em_rail_ejector";
  const rayReceiver = entity.buildingId === "ray_receiver";
  const launchSilo = entity.buildingId === "vertical_launching_silo";
  const industrialProfile = getPlanetIndustrialProfile(game, entity.planetId);
  const specializationMultiplier = specializationApplies(industrialProfile, building.family, entity.buildingId)
    ? industrialProfile.productionSpeedMultiplier
    : 1;
  return (
    <div className="inspector-content">
      <div className="inspector-identity">
        <i className={`building-mark${rayReceiver ? " building-mark--ray" : ""}`}>{entity.kind === "power" ? entity.buildingId === "solar_panel" ? <Sun size={18} /> : entity.buildingId === "geothermal_power_station" ? <ThermometerSun size={18} /> : <Wind size={18} /> : railEjector ? <Satellite size={18} /> : launchSilo ? <Rocket size={18} /> : rayReceiver ? <RadioTower size={18} /> : <Factory size={18} />}</i>
        <div><span>{entity.kind === "power" ? "能源设施" : railEjector ? "恒星轨道设施" : launchSilo ? "戴森球建造设施" : rayReceiver ? "戴森系统接收设施" : "生产设备"}</span><strong>{building.name} ×{entity.machineCount}</strong></div>
      </div>
      {entity.kind === "machine" ? (
        <div className="recipe-select" data-inspector-section="recipe" data-inspector-section-label="配方与主要模式" aria-label="配方与主要模式">
          <span>当前配方</span>
          <RecipeCatalogPicker value={entity.recipeId} recipes={recipeOptions} onChange={(recipeId) => onRecipeChange(entity.id, recipeId)} />
        </div>
      ) : null}
      {railEjector ? <EjectorOrbitTargetControl game={game} entities={[entity]} onChange={(entityIds, orbitId) => onEjectorOrbitChange(entityIds[0], orbitId)} /> : null}
      <dl className="metric-ledger">
        {entity.kind === "power" ? (
          <>
            <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
            <div><dt>实时发电</dt><dd><PowerValue valueKw={entity.powerOutputKw ?? 0} /></dd></div>
            <div><dt>额定发电</dt><dd><PowerValue valueKw={(building.powerGenerationKw ?? 0) * entity.machineCount * (entity.buildingId === "solar_panel" ? getPlanetIndustrialProfile(game, entity.planetId).solarMultiplier : entity.buildingId === "geothermal_power_station" ? getPlanetIndustrialProfile(game, entity.planetId).geothermalMultiplier : getPlanetIndustrialProfile(game, entity.planetId).windMultiplier)} /></dd></div>
          </>
        ) : (
          <>
            <div><dt>设备状态</dt><dd className={`status-text status-text--${status.tone}`}>{status.label}</dd></div>
            <div><dt>当前负载</dt><dd>{Math.round(entity.utilization * 100)}%</dd></div>
            {rayReceiver ? <div><dt>接收功率</dt><dd><PowerValue valueKw={entity.powerOutputKw ?? 0} /></dd></div> : null}
            <div><dt>{railEjector || launchSilo ? "发射速率" : "实际产出"}</dt><dd>{recipe?.id === "ray_power" ? <PowerValue valueKw={entity.powerOutputKw ?? 0} /> : `${entity.productionRate.toFixed(1)}/min`}</dd></div>
            {specializationMultiplier !== 1 ? <div><dt>行星工业加成</dt><dd>{industrialProfile.specializationName ?? "行星专精"} · {specializationMultiplier.toFixed(2)}×</dd></div> : null}
            <div><dt>{rayReceiver ? "额定接收" : "额定耗电"}</dt><dd><PowerValue valueKw={rayReceiver ? getRayReceiverCapacityKw(game) * entity.machineCount : (building.powerDemandKw ?? 0) * entity.machineCount} /></dd></div>
            {entity.kind === "machine" && entity.sprayCoaterInstalled ? (
              <>
                <div><dt>喷涂速度</dt><dd>{getEntityProliferatorSpeedMultiplier(entity).toFixed(2)}×</dd></div>
                <div><dt>喷涂耗电</dt><dd>{getEntityProliferatorPowerMultiplier(entity).toFixed(2)}×</dd></div>
              </>
            ) : null}
            <div><dt>配方周期</dt><dd>{recipe?.id === "ray_power" ? "连续" : recipe ? `${recipe.duration.toFixed(1)} s` : "-"}</dd></div>
            {railEjector ? <div><dt>戴森云轨道帆</dt><dd>{formatQuantityCompact(game.dysonSwarm.sailsInOrbit)}</dd></div> : null}
            {launchSilo ? <div><dt>永久结构点</dt><dd>{formatQuantityCompact(game.dysonSphere.structurePoints)}</dd></div> : null}
          </>
        )}
      </dl>
      <PowerNetworkControl game={game} entity={entity} onGridChange={onPowerGridChange} onPowerPriorityChange={onPowerPriorityChange} onGenerationPriorityChange={onGenerationPriorityChange} />
      <ProliferatorControl game={game} entity={entity} onInstall={onInstallSprayCoater} onRemove={onRemoveSprayCoater} onConfigure={onProliferatorConfiguration} />
      <EquipmentUpgradeControl game={game} entity={entity} onUpgrade={onUpgrade} />
      <p className="inspector-description">{building.description}</p>
      <EntityManagementActions game={game} entity={entity} onSetTarget={onSetTarget} onRemove={onRemove} />
    </div>
  );
}

function beltTierRoman(tier: BeltTier): string {
  return tier === 3 ? "III" : tier === 2 ? "II" : tier === 1 ? "I" : String(tier);
}

function BeltInspector({ game, belt, hasCopiedConfiguration, focused, onPriorityChange, onLaneCountChange, onStackSizeChange, onMonitorChange, onRouteModeChange, onRouteOffsetChange, onApplyConfigurationToNetwork, onFocusNetwork, onUpgrade, onUpgradeNetwork, onCopyConfiguration, onPasteConfiguration, onRemove, onRemoveNetwork }: {
  game: GameState;
  belt: BeltConnection;
  hasCopiedConfiguration: boolean;
  focused: boolean;
  onPriorityChange: (beltId: string, priority: 0 | 1 | 2) => void;
  onLaneCountChange: (beltId: string, targetLanes: number) => void;
  onStackSizeChange: (beltId: string, stackSize: CargoStackSize) => void;
  onMonitorChange: (beltId: string, enabled: boolean) => void;
  onRouteModeChange: (beltId: string, routeMode: BeltRouteMode) => void;
  onRouteOffsetChange: (beltId: string, routeOffsetY: number) => void;
  onApplyConfigurationToNetwork: (beltId: string) => void;
  onFocusNetwork: (beltId: string) => void;
  onUpgrade: (beltId: string) => void;
  onUpgradeNetwork: (beltId: string) => void;
  onCopyConfiguration: (beltId: string) => void;
  onPasteConfiguration: (beltId: string) => void;
  onRemove: (beltId: string) => void;
  onRemoveNetwork: (beltId: string) => void;
}) {
  const [laneDraft, setLaneDraft] = useState(String(belt.lanes));
  const [laneError, setLaneError] = useState<string | null>(null);
  const item = getItem(belt.itemId);
  const capacity = getBeltCapacity(belt);
  const targetTier = getNextBeltTier(belt.tier);
  const targetId = targetTier ? getBeltConstructionId(targetTier) : null;
  const targetDefinition = targetId ? getConstructionDefinition(targetId) : undefined;
  const targetStock = targetId ? game.construction[targetId] ?? 0 : 0;
  const targetUnlocked = !targetDefinition?.requiredTechId || isTechnologyCompleted(game, targetDefinition.requiredTechId);
  const networkIds = getBeltNetworkIds(game, belt.id);
  const stackSize = belt.stackSize ?? 1;
  const congestion = belt.congestion ?? 0;
  const network = analyzeBeltNetwork(game, belt.id);
  const diagnostic = network?.diagnostics.find((entry) => entry.beltId === belt.id);
  const routeMode = belt.routeMode ?? "auto";
  const beltConstructionId = getBeltConstructionId(belt.tier);
  const beltStock = Math.max(0, Math.floor(game.construction[beltConstructionId] ?? 0));
  const decreaseCheck = getBeltLaneAdjustmentCheck(game, belt.id, belt.lanes - 1);
  const increaseCheck = getBeltLaneAdjustmentCheck(game, belt.id, belt.lanes + 1);
  useEffect(() => {
    setLaneDraft(String(belt.lanes));
    setLaneError(null);
  }, [belt.id, belt.lanes]);
  const commitLaneDraft = () => {
    if (!/^\d+$/.test(laneDraft.trim())) {
      setLaneError("并联数量必须为整数");
      return;
    }
    const target = Number(laneDraft.trim());
    const check = getBeltLaneAdjustmentCheck(game, belt.id, target);
    if (!check.ok) {
      setLaneError(check.label);
      return;
    }
    setLaneError(null);
    setLaneDraft(String(target));
    onLaneCountChange(belt.id, target);
  };
  return (
    <div className="inspector-content">
      <div className="inspector-identity">
        <ItemMark itemId={belt.itemId} />
        <div><span>物流连接</span><strong>{item.name}运输线</strong></div>
      </div>
      <dl className="metric-ledger">
        <div><dt>传送带等级</dt><dd>Mk.{beltTierRoman(belt.tier)}</dd></div>
        <div><dt>并行线路</dt><dd>×{belt.lanes}</dd></div>
        <div><dt>近期流量</dt><dd>{(diagnostic?.flow ?? belt.lastFlow).toFixed(2)}/s</dd></div>
        <div><dt>采样窗口</dt><dd>{diagnostic && diagnostic.sampleSeconds > 0 ? `${diagnostic.sampleSeconds.toFixed(1)} 模拟秒${diagnostic.sampling ? " · 采样中" : ""}` : "等待首个样本"}</dd></div>
        <div><dt>窗口运输</dt><dd>{diagnostic ? Math.floor(diagnostic.sampleTransferred).toLocaleString("zh-CN") : 0} 件</dd></div>
        <div><dt>线路上限</dt><dd>{capacity.toFixed(0)}/s</dd></div>
        <div><dt>货物堆叠</dt><dd>×{stackSize}</dd></div>
        <div><dt>网络线路</dt><dd>{networkIds.length}</dd></div>
        <div><dt>累计运输</dt><dd>{Math.floor(belt.totalTransferred ?? 0).toLocaleString("zh-CN")}</dd></div>
        <div><dt>理论供给</dt><dd>{diagnostic?.sourceRatePerSecond == null ? "待配置" : `${diagnostic.sourceRatePerSecond.toFixed(2)}/s`}</dd></div>
        <div><dt>理论需求</dt><dd>{diagnostic?.demandRatePerSecond == null ? "待配置" : `${diagnostic.demandRatePerSecond.toFixed(2)}/s`}</dd></div>
        <div><dt>拥堵指数</dt><dd className={congestion > 0.8 ? "status-text status-text--blocked" : ""}>{Math.round(congestion * 100)}%</dd></div>
      </dl>
      {diagnostic ? <p className={`belt-diagnostic belt-diagnostic--${diagnostic.health}`}>近期模拟趋势 · {diagnostic.label}</p> : null}
      <div className="capacity-bar"><i style={{ width: `${Math.min(100, (diagnostic?.flow ?? belt.lastFlow) / capacity * 100)}%`, backgroundColor: item.color }} /></div>
      <section className="belt-lane-control" aria-label="传送带并联数量">
        <header><span><Layers3 size={14} />并联线路数量</span><strong>{getConstructionDefinition(beltConstructionId)?.name ?? "同级传送带"}库存 {beltStock}</strong></header>
        <div>
          <button type="button" disabled={!decreaseCheck.ok} title={decreaseCheck.label} onClick={() => onLaneCountChange(belt.id, belt.lanes - 1)} aria-label="减少一条并联线路"><Minus size={15} /></button>
          <input inputMode="numeric" pattern="[0-9]*" min={1} max={Math.max(MAX_BELT_LANES, belt.lanes)} value={laneDraft} onChange={(event) => { setLaneDraft(event.target.value); setLaneError(null); }} onBlur={commitLaneDraft} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitLaneDraft(); } else if (event.key === "Escape") { setLaneDraft(String(belt.lanes)); setLaneError(null); } }} aria-label="并联线路目标数量" aria-invalid={Boolean(laneError)} />
          <button type="button" disabled={!increaseCheck.ok} title={increaseCheck.label} onClick={() => onLaneCountChange(belt.id, belt.lanes + 1)} aria-label="增加一条并联线路"><Plus size={15} /></button>
        </div>
        <small>数量影响吞吐；调整不会改变等级、堆叠、路由、优先级或在途物资。上限 {MAX_BELT_LANES}。</small>
        {laneError ? <p role="alert">{laneError}</p> : null}
      </section>
      {network ? <section className={`belt-network-diagnostic belt-network-diagnostic--${network.health}`}>
        <header><span><Route size={14} />连续网络诊断</span><strong>{network.label}</strong></header>
        <div>
          <span>线路 <strong>{network.beltIds.length}</strong></span>
          <span>节点 <strong>{network.entityIds.length}</strong></span>
          <span>上游 <strong>{network.sourceEntityIds.length}</strong></span>
          <span>下游 <strong>{network.sinkEntityIds.length}</strong></span>
        </div>
        <div className="belt-network-load"><i><b style={{ width: `${Math.min(100, network.utilization * 100)}%` }} /></i><span>综合利用率 {Math.round(network.utilization * 100)}%</span><strong>最高拥堵 {Math.round(network.maxCongestion * 100)}%</strong></div>
      </section> : null}
      <section className="belt-routing-controls">
        <span>线路优先级</span>
        <div className="segmented-control">{([0, 1, 2] as const).map((priority) => <button className={belt.priority === priority ? "active" : ""} type="button" key={priority} onClick={() => onPriorityChange(belt.id, priority)}>{priority === 2 ? "高" : priority === 1 ? "标准" : "低"}</button>)}</div>
        <span>货物堆叠</span>
        <div className="segmented-control">{([1, 2, 4] as CargoStackSize[]).map((size) => <button className={stackSize === size ? "active" : ""} type="button" disabled={!canSetBeltStackSize(game, size)} key={size} onClick={() => onStackSizeChange(belt.id, size)}>×{size}</button>)}</div>
        <span>画布路由</span>
        <div className="segmented-control belt-route-mode">{([
          ["bezier", "曲线"], ["auto", "避让"], ["upper", "上绕"], ["lower", "下绕"], ["manual", "手动"],
        ] as Array<[BeltRouteMode, string]>).map(([mode, label]) => <button className={routeMode === mode ? "active" : ""} type="button" key={mode} onClick={() => onRouteModeChange(belt.id, mode)}>{label}</button>)}</div>
        {routeMode === "manual" ? <label className="belt-route-offset"><span>控制点高度</span><input type="range" min={-600} max={600} step={20} value={belt.routeOffsetY ?? 0} onChange={(event) => onRouteOffsetChange(belt.id, Number(event.target.value))} /><output>{belt.routeOffsetY ?? 0}</output></label> : null}
        <label className="toggle-row"><input type="checkbox" checked={belt.monitorEnabled ?? false} onChange={(event) => onMonitorChange(belt.id, event.target.checked)} /><span>启用线路流量监测</span></label>
      </section>
      <div className="belt-clipboard-actions">
        <button type="button" onClick={() => onCopyConfiguration(belt.id)}><ClipboardCopy size={14} />复制设置</button>
        <button type="button" disabled={!hasCopiedConfiguration} onClick={() => onPasteConfiguration(belt.id)}><ClipboardPaste size={14} />粘贴设置</button>
        <button type="button" onClick={() => onApplyConfigurationToNetwork(belt.id)}><Layers3 size={14} />设置应用整网</button>
        <button type="button" className={focused ? "active" : ""} onClick={() => onFocusNetwork(belt.id)}><Route size={14} />{focused ? "取消网络聚焦" : "聚焦上下游"}</button>
      </div>
      {targetTier && targetId ? (
        <section className="equipment-upgrade equipment-upgrade--belt">
          <header><span><ArrowUp size={14} />线路升级</span><strong>Mk.{beltTierRoman(belt.tier)} → Mk.{beltTierRoman(targetTier)}</strong></header>
          <dl>
            <div><dt>线路上限</dt><dd>{capacity.toFixed(0)} → {getBeltCapacity({ ...belt, tier: targetTier }).toFixed(0)}/s</dd></div>
            <div><dt>升级传送带</dt><dd>{targetStock}/{belt.lanes}</dd></div>
          </dl>
          <button type="button" disabled={!canUpgradeBelt(game, belt.id)} onClick={() => onUpgrade(belt.id)} title={targetUnlocked ? `升级为传送带 Mk.${beltTierRoman(targetTier)}` : `需要科技：${getTechnology(targetDefinition?.requiredTechId)?.name ?? "未解锁"}`}>
            {targetUnlocked ? <ArrowUp size={14} /> : <LockKeyhole size={14} />}
            {targetUnlocked ? `升级线路 ×${belt.lanes}` : "科技锁定"}
          </button>
          <button type="button" disabled={!targetUnlocked || networkIds.every((id) => !canUpgradeBelt(game, id))} onClick={() => onUpgradeNetwork(belt.id)}><Layers3 size={14} />升级整条网络</button>
        </section>
      ) : null}
      <button className="danger-command" type="button" onClick={() => onRemove(belt.id)}>
        <Trash2 size={15} /> 回收运输线
      </button>
      {network && network.beltIds.length > 1 ? <button className="danger-command danger-command--network" type="button" onClick={() => onRemoveNetwork(belt.id)}>
        <Trash2 size={15} /> 回收整条网络 ×{network.beltIds.length}
      </button> : null}
    </div>
  );
}

type FabricatorMode = "construction" | "items";
type FabricatorSearchHistory = Record<FabricatorMode, string[]>;

const FABRICATOR_SEARCH_HISTORY_KEY = "dsp-idle-network.fabricator-search-history.v1";

function normalizeFabricatorSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const entry = candidate.trim().slice(0, 60);
    const identity = entry.toLocaleLowerCase("zh-CN");
    if (!entry || seen.has(identity)) continue;
    seen.add(identity);
    entries.push(entry);
    if (entries.length === 3) break;
  }
  return entries;
}

function loadFabricatorSearchHistory(): FabricatorSearchHistory {
  try {
    const value = JSON.parse(window.localStorage.getItem(FABRICATOR_SEARCH_HISTORY_KEY) ?? "{}") as Record<string, unknown>;
    return {
      construction: normalizeFabricatorSearchHistory(value.construction),
      items: normalizeFabricatorSearchHistory(value.items),
    };
  } catch {
    return { construction: [], items: [] };
  }
}

function saveFabricatorSearchHistory(history: FabricatorSearchHistory) {
  try { window.localStorage.setItem(FABRICATOR_SEARCH_HISTORY_KEY, JSON.stringify(history)); } catch { /* optional convenience state */ }
}

function Fabricator({ game, focusItemId, onCraft, onCraftItem, onQueueCraftItem, onCancelCraftQueue }: {
  game: GameState;
  focusItemId?: ItemId | null;
  onCraft: InspectorPanelProps["onCraft"];
  onCraftItem: InspectorPanelProps["onCraftItem"];
  onQueueCraftItem: InspectorPanelProps["onQueueCraftItem"];
  onCancelCraftQueue: InspectorPanelProps["onCancelCraftQueue"];
}) {
  const [mode, setMode] = useState<FabricatorMode>("construction");
  const [view, setView] = useState<"compact" | "detail">("compact");
  const [query, setQuery] = useState("");
  const [searchHistory, setSearchHistory] = useState<FabricatorSearchHistory>(loadFabricatorSearchHistory);
  const [searchHistoryOpen, setSearchHistoryOpen] = useState(false);
  const [batches, setBatches] = useState(1);
  const [quantityTargetId, setQuantityTargetId] = useState<string | null>(null);
  const [focusedHandcraftItemId, setFocusedHandcraftItemId] = useState<ItemId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const handcraftRecipes = useMemo(() => Object.values(RECIPES).filter((recipe) => {
    if (!isHandcraftableRecipe(recipe.id)) return false;
    if (!term) return true;
    const itemNames = [...recipe.inputs, ...recipe.outputs].map((entry) => getItem(entry.itemId).name).join(" ");
    return `${recipe.name} ${itemNames} ${getBuilding(recipe.buildingId).name}`.toLocaleLowerCase("zh-CN").includes(term);
  }), [term]);
  const constructionDefinitions = useMemo(() => CONSTRUCTION.filter((definition) =>
    (definition.buildingId !== "orbital_cargo_terminal" || game.mode === "normal" && game.orbitalStation.status !== "locked") &&
    (!term || `${definition.name} ${definition.costs.map((cost) => getItem(cost.itemId).name).join(" ")}`.toLocaleLowerCase("zh-CN").includes(term))), [game.mode, game.orbitalStation.status, term]);
  const handcraftOutputItemIds = useMemo(() => new Set(Object.values(RECIPES).filter((recipe) => isHandcraftableRecipe(recipe.id)).flatMap((recipe) => recipe.outputs.map((output) => output.itemId))), []);
  const constructionPlans = useMemo(() => new Map(constructionDefinitions.map((definition) => [
    definition.buildingId,
    getConstructionQuickCraftPlan(game, definition.buildingId, batches),
  ])), [constructionDefinitions, game.research.completedTechIds, game.tray, game.portableFleet, batches]);
  const recursivePlans = useMemo(() => new Map(handcraftRecipes.map((recipe) => [
    recipe.id,
    getRecursiveHandcraftPlan(game, recipe.id, batches),
  ])), [handcraftRecipes, game.research.completedTechIds, game.tray, game.portableFleet, batches]);
  const recentSearches = searchHistory[mode];
  const quantityConstruction = constructionDefinitions.find((definition) => definition.buildingId === quantityTargetId) ?? constructionDefinitions[0];
  const quantityRecipe = handcraftRecipes.find((recipe) => recipe.id === quantityTargetId) ?? handcraftRecipes[0];
  const quantityTargetName = mode === "construction"
    ? quantityConstruction?.name ?? "建筑"
    : quantityRecipe ? getItem(quantityRecipe.outputs[0].itemId).name : "物品";
  const maxBatches = () => mode === "construction"
    ? quantityConstruction ? getMaxConstructionQuickCraftBatches(game, quantityConstruction.buildingId) : 1
    : quantityRecipe ? getMaxRecursiveHandcraftBatches(game, quantityRecipe.id) : 1;
  const searchHistoryId = `fabricator-search-history-${mode}`;
  const rememberSearch = (targetMode: FabricatorMode, value: string) => {
    const entry = value.trim().slice(0, 60);
    if (!entry) return;
    setSearchHistory((current) => {
      const identity = entry.toLocaleLowerCase("zh-CN");
      const entries = [entry, ...current[targetMode].filter((candidate) => candidate.toLocaleLowerCase("zh-CN") !== identity)].slice(0, 3);
      const next = { ...current, [targetMode]: entries };
      saveFabricatorSearchHistory(next);
      return next;
    });
  };
  const clearSearchHistory = () => {
    setSearchHistory((current) => {
      const next = { ...current, [mode]: [] };
      saveFabricatorSearchHistory(next);
      return next;
    });
    setSearchHistoryOpen(false);
  };
  const useRecentSearch = (entry: string) => {
    setQuery(entry);
    setFocusedHandcraftItemId(null);
    rememberSearch(mode, entry);
    setSearchHistoryOpen(false);
  };
  const focusHandcraftItem = (itemId: ItemId) => {
    setMode("items");
    setBatches(1);
    setQuery(getItem(itemId).name);
    setFocusedHandcraftItemId(itemId);
    setSearchHistoryOpen(false);
  };
  useEffect(() => {
    if (focusItemId) focusHandcraftItem(focusItemId);
  }, [focusItemId]);
  useEffect(() => {
    if (mode !== "items" || !focusedHandcraftItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-output-item="${focusedHandcraftItemId}"]`);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedHandcraftItemId, mode, query]);
  return (
    <div className="fabricator-workspace">
      <div className="fabricator-sticky-tools">
        <div className="fabricator-topbar">
          <div className="fabricator-mode segmented-control" aria-label="基础制造模式">
            <button className={mode === "construction" ? "active" : ""} type="button" onClick={() => { setMode("construction"); setQuery(""); setFocusedHandcraftItemId(null); setSearchHistoryOpen(false); }}>建筑制造</button>
            <button className={mode === "items" ? "active" : ""} type="button" onClick={() => { setMode("items"); setQuery(""); setFocusedHandcraftItemId(null); setSearchHistoryOpen(false); }}>物品手工</button>
          </div>
          <div className="fabricator-view" role="group" aria-label="制造列表视图">
            <button className={view === "compact" ? "active" : ""} type="button" onClick={() => setView("compact")} title="精简网格" aria-label="精简网格"><LayoutGrid size={14} /></button>
            <button className={view === "detail" ? "active" : ""} type="button" onClick={() => setView("detail")} title="详细列表" aria-label="详细列表"><Rows3 size={14} /></button>
          </div>
        </div>
        <div className="handcraft-tools">
            <div
              className="handcraft-search"
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                rememberSearch(mode, query);
                setSearchHistoryOpen(false);
              }}
            >
              <label><Search size={13} /><StableTextInput
                draftId={`fabricator-search:${mode}`}
                value={query}
                maxLength={60}
                autoComplete="off"
                aria-expanded={searchHistoryOpen && recentSearches.length > 0}
                aria-controls={searchHistoryOpen && recentSearches.length > 0 ? searchHistoryId : undefined}
                onFocus={() => setSearchHistoryOpen(true)}
                onClick={() => setSearchHistoryOpen(true)}
                onValueChange={(value) => { setQuery(value); setFocusedHandcraftItemId(null); setSearchHistoryOpen(false); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    rememberSearch(mode, query);
                    setSearchHistoryOpen(false);
                  } else if (event.key === "Escape") {
                    setSearchHistoryOpen(false);
                  }
                }}
                placeholder={mode === "items" ? "搜索物品、原料或设备" : "搜索建筑或材料"}
                aria-label={mode === "items" ? "搜索手工配方" : "搜索建筑制造"}
              /></label>
              {searchHistoryOpen && recentSearches.length > 0 ? <div className="fabricator-search-history" id={searchHistoryId} aria-label={mode === "items" ? "物品手工最近搜索" : "建筑制造最近搜索"}>
                <header><History size={12} /><span>最近搜索</span><button type="button" onClick={clearSearchHistory} title="清除最近搜索" aria-label={mode === "items" ? "清除物品手工搜索历史" : "清除建筑制造搜索历史"}><Trash2 size={12} /></button></header>
                <div className="fabricator-search-history-options">
                  {recentSearches.map((entry) => <button type="button" key={entry} onClick={() => useRecentSearch(entry)} title={`搜索${entry}`}><History size={11} /><span>{entry}</span></button>)}
                </div>
              </div> : null}
            </div>
            <div className="fabricator-quantity"><span>批次 · {quantityTargetName}</span><QuantityStepper value={batches} max={MAX_MANUAL_CRAFT_BATCHES} onChange={setBatches} onMax={maxBatches} label={mode === "items" ? "手工制造批次" : "建筑制造批次"} /></div>
        </div>
      </div>
      {mode === "items" && game.handcraftQueue.length > 0 ? <section className="handcraft-queue" aria-label="手工制造队列">
        <header><ListChecks size={14} /><span>手工制造队列</span><strong>{game.handcraftQueue.length}/20</strong></header>
        <div>{game.handcraftQueue.map((entry, index) => {
          const recipe = getRecipe(entry.recipeId);
          if (!recipe) return null;
          const output = recipe.outputs[0];
          const waitingForPlanet = entry.planetId !== game.activePlanetId;
          const hasInputs = recipe.inputs.every((input) => (game.tray[input.itemId] ?? 0) >= input.amount);
          return <article className={index === 0 && !waitingForPlanet && hasInputs ? "handcraft-queue-row handcraft-queue-row--active" : "handcraft-queue-row"} key={entry.id}>
            <ItemMark itemId={output.itemId} /><span><strong>{getItem(output.itemId).name}</strong><small>{entry.batchesRemaining}/{entry.batchesTotal} 批 · {waitingForPlanet ? "等待行星" : hasInputs ? "生产中" : "等待原料"}</small><i role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(entry.progress * 100)}><b style={{ width: `${entry.progress * 100}%` }} /></i></span><button type="button" onClick={() => onCancelCraftQueue(entry.id)} title="取消手工队列" aria-label={`取消${getItem(output.itemId).name}手工队列`}><X size={13} /></button>
          </article>;
        })}</div>
      </section> : null}
      <div ref={listRef} className={`fabricator-list${mode === "items" ? " fabricator-list--items" : ""}${view === "compact" ? " fabricator-list--compact" : ""}`}>
      {mode === "construction" ? constructionDefinitions.map((definition) => {
        const unlocked = !definition.requiredTechId || isTechnologyCompleted(game, definition.requiredTechId);
        const plan = constructionPlans.get(definition.buildingId) ?? getConstructionQuickCraftPlan(game, definition.buildingId, batches);
        return (
          <article className={`fabricator-row${quantityConstruction?.buildingId === definition.buildingId ? " fabricator-row--quantity-target" : ""}`} key={definition.buildingId} onPointerDown={() => setQuantityTargetId(definition.buildingId)}>
            <header>
              <i>{isConveyorBeltId(definition.buildingId) ? <Layers3 size={16} /> : <Hammer size={16} />}</i>
              <div><strong>{definition.name}</strong><span>{batches} 批 · 实际产出 ×{plan.outputAmount}</span></div>
              <button type="button" disabled={!plan.possible} onClick={() => onCraft(definition.buildingId, batches)} title={`制造${definition.name} ×${plan.outputAmount}`}>
                {unlocked ? <Wrench size={15} /> : <LockKeyhole size={15} />} {unlocked ? `制造 ×${plan.outputAmount}` : "锁定"}
              </button>
            </header>
            {!unlocked && definition.requiredTechId ? (
              <div className="fabricator-lock"><LockKeyhole size={11} /> {getTechnology(definition.requiredTechId)?.name}</div>
            ) : null}
            <div className="fabricator-costs">
              {definition.costs.map((cost) => {
                const current = game.tray[cost.itemId] ?? 0;
                const required = cost.amount * batches;
                if (current >= required) return <span className="cost cost--ready" key={cost.itemId}><ItemMark itemId={cost.itemId} /> {formatQuantityCompact(current)}/{formatQuantityCompact(required)}</span>;
                return <button className="cost cost--missing-link" type="button" key={cost.itemId} onClick={() => focusHandcraftItem(cost.itemId)} title={`转到${getItem(cost.itemId).name}手工制造`} aria-label={`手工制造${getItem(cost.itemId).name}`}><ItemMark itemId={cost.itemId} /> {formatQuantityCompact(current)}/{formatQuantityCompact(required)}</button>;
              })}
            </div>
            {plan.possible && plan.usesUpstream ? <small className="fabricator-plan-summary">递归合成 · 实际消耗 {plan.consumedItems.map((item) => `${getItem(item.itemId).name}×${formatQuantityCompact(item.amount)}`).join("、")}</small> : plan.blocker ? <small className="fabricator-plan-summary warning">安全上限：{getItem(plan.blocker.itemId).name} {formatQuantityCompact(plan.blocker.expected)}/{formatQuantityCompact(plan.blocker.limit)}</small> : !plan.possible && plan.missingItems.length > 0 ? <small className="fabricator-plan-summary warning">缺口 {plan.missingItems.map((item) => `${getItem(item.itemId).name}×${formatQuantityCompact(item.missing)}`).join("、")}</small> : null}
          </article>
        );
      }) : handcraftRecipes.map((recipe) => {
        const output = recipe.outputs[0];
        const unlocked = !recipe.requiredTechId || isTechnologyCompleted(game, recipe.requiredTechId);
        const recursivePlan = recursivePlans.get(recipe.id) ?? getRecursiveHandcraftPlan(game, recipe.id, batches);
        const available = recursivePlan.possible;
        return (
          <article className={`fabricator-row handcraft-row${focusedHandcraftItemId === output.itemId ? " fabricator-row--focused" : ""}${quantityRecipe?.id === recipe.id ? " fabricator-row--quantity-target" : ""}`} data-output-item={output.itemId} tabIndex={-1} key={recipe.id} onPointerDown={() => setQuantityTargetId(recipe.id)}>
            <header>
              <ItemMark itemId={output.itemId} />
              <div><strong>{getItem(output.itemId).name}</strong><span>{getBuilding(recipe.buildingId).shortName} · {recipe.duration}s · 单批 ×{output.amount}</span></div>
              <div className="handcraft-actions">
                <button type="button" disabled={!available} onClick={() => onCraftItem(recipe.id, batches)} title={`立即手工制造${getItem(output.itemId).name}`}>
                  {unlocked ? <Hammer size={14} /> : <LockKeyhole size={14} />} {unlocked ? `制作 ×${formatQuantityCompact(output.amount * batches)}` : "锁定"}
                </button>
                <button type="button" disabled={!canQueueHandcraftRecipe(game, recipe.id)} onClick={() => onQueueCraftItem(recipe.id, batches)} title={`加入${getItem(output.itemId).name}手工队列`} aria-label={`排队制造${getItem(output.itemId).name}`}><ListPlus size={14} /></button>
              </div>
            </header>
            {!unlocked && recipe.requiredTechId ? <div className="fabricator-lock"><LockKeyhole size={11} /> {getTechnology(recipe.requiredTechId)?.name}</div> : null}
            <div className="fabricator-costs">
              {recipe.inputs.map((input) => {
                const current = Math.floor(game.tray[input.itemId] ?? 0);
                const required = input.amount * batches;
                if (current < required && handcraftOutputItemIds.has(input.itemId)) {
                  return <button className="cost cost--missing-link" type="button" key={input.itemId} onClick={() => focusHandcraftItem(input.itemId)} title={`转到${getItem(input.itemId).name}手工制造`} aria-label={`手工制造${getItem(input.itemId).name}`}><ItemMark itemId={input.itemId} /> {formatQuantityCompact(current)}/{formatQuantityCompact(required)}</button>;
                }
                return <span className={current >= required ? "cost cost--ready" : "cost"} key={input.itemId}><ItemMark itemId={input.itemId} /> {formatQuantityCompact(current)}/{formatQuantityCompact(required)}</span>;
              })}
            </div>
            {recursivePlan.possible && recursivePlan.decisions.length > 1 ? <small className="fabricator-plan-summary">递归合成 · {recursivePlan.decisions.map((decision) => getRecipe(decision.recipeId)?.name ?? decision.recipeId).join(" → ")}</small>
              : !recursivePlan.possible && recursivePlan.blocker ? <small className="fabricator-plan-summary warning">{recursivePlan.blocker.reason === "technology" ? "科技未解锁" : recursivePlan.blocker.reason === "capacity" ? "物资托盘已满" : `缺少 ${getItem(recursivePlan.blocker.itemId).name} ×${formatQuantityCompact(Math.max(0, recursivePlan.blocker.required - recursivePlan.blocker.current))}`}</small> : null}
          </article>
        );
      })}
      {mode === "construction" && constructionDefinitions.length === 0 ? <div className="fabricator-empty">没有符合条件的建筑</div> : null}
      {mode === "items" && handcraftRecipes.length === 0 ? <div className="fabricator-empty">没有符合条件的手工配方</div> : null}
      </div>
    </div>
  );
}

const INSPECTOR_SECTION_LABELS: Record<InspectorSectionId, string> = {
  recipe: "配方与主要模式",
  stack: "堆叠与回收",
  upgrade: "建筑升级",
  proliferator: "喷涂配置",
  power: "电力与优先级",
};

function InspectorLayoutControls({ preference, onChange }: {
  preference: InspectorLayoutPreferenceV1;
  onChange: (next: InspectorLayoutPreferenceV1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<InspectorSectionId | null>(null);
  const pointerDrag = useRef<{ id: InspectorSectionId; pointerId: number; startY: number; active: boolean } | null>(null);
  const move = (source: InspectorSectionId, target: InspectorSectionId) => {
    if (source === target) return;
    const order = preference.order.filter((id) => id !== source);
    order.splice(order.indexOf(target), 0, source);
    onChange({ ...preference, order });
  };
  return <section className="inspector-layout-controls">
    <header><button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}><Rows3 size={14} />检查器布局</button>{open ? <button type="button" onClick={() => onChange({ version: 1, order: [...DEFAULT_INSPECTOR_SECTION_ORDER], collapsed: [] })} title="恢复默认排序"><RotateCcw size={14} />恢复默认</button> : null}</header>
    {open ? <div>{preference.order.map((id, index) => <div className={dragging === id ? "dragging" : ""} data-inspector-layout-row={id} key={id}>
      <button
        className="inspector-layout-grip"
        type="button"
        title="拖动排序；Alt+方向键也可调整"
        aria-label={`调整${INSPECTOR_SECTION_LABELS[id]}顺序`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerDrag.current = { id, pointerId: event.pointerId, startY: event.clientY, active: false };
        }}
        onPointerMove={(event) => {
          const current = pointerDrag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          if (!current.active && Math.abs(event.clientY - current.startY) >= 6) {
            current.active = true;
            setDragging(current.id);
          }
          if (!current.active) return;
          const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-inspector-layout-row]");
          const target = row?.dataset.inspectorLayoutRow as InspectorSectionId | undefined;
          if (target && target !== current.id) move(current.id, target);
        }}
        onPointerUp={(event) => {
          pointerDrag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(null);
        }}
        onPointerCancel={() => { pointerDrag.current = null; setDragging(null); }}
        onLostPointerCapture={() => { pointerDrag.current = null; setDragging(null); }}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          const target = preference.order[index + (event.key === "ArrowUp" ? -1 : 1)];
          if (target) move(id, target);
        }}
      ><GripVertical size={15} /></button>
      <span>{INSPECTOR_SECTION_LABELS[id]}</span>
      <button type="button" aria-pressed={preference.collapsed.includes(id)} onClick={() => onChange({ ...preference, collapsed: preference.collapsed.includes(id) ? preference.collapsed.filter((entry) => entry !== id) : [...preference.collapsed, id] })}>{preference.collapsed.includes(id) ? "展开" : "折叠"}</button>
    </div>)}</div> : null}
  </section>;
}

function NativeReadOnlyInspectorPanel(props: InspectorPanelProps) {
  const inspectorProjectionReady = props.inspectorReadModel.source === "native-core" &&
    Number.isSafeInteger(props.inspectorReadModel.revision) && (props.inspectorReadModel.revision ?? -1) >= 0 &&
    props.inspectorReadModel.schema === "factory-read-model-v1" && (
      props.selectedEntity && !props.selectedBelt && props.inspectorReadModel.belt === null &&
        props.inspectorReadModel.entity !== null &&
        props.inspectorReadModel.activePlanetId === props.selectedEntity.planetId &&
        desktopEntitySummaryMatches(props.selectedEntity, props.inspectorReadModel.entity) ||
      props.selectedBelt && !props.selectedEntity && props.inspectorReadModel.entity === null &&
        props.inspectorReadModel.belt !== null &&
        props.inspectorReadModel.activePlanetId === props.selectedBelt.planetId &&
        desktopBeltSummaryMatches(props.selectedBelt, props.inspectorReadModel.belt)
    );
  const multipleSelection = props.selectedEntities.length + props.multiSelectedBelts.length > 1;
  // The legacy GameState mirror deliberately does not follow an active-planet
  // command after Rust becomes authoritative. Bind only the display helper's
  // route check to the already verified projection identity; no gameplay data
  // is copied from or written back to that mirror.
  const projectionGame = inspectorProjectionReady &&
      props.game.activePlanetId !== props.inspectorReadModel.activePlanetId
    ? { ...props.game, activePlanetId: props.inspectorReadModel.activePlanetId as PlanetId }
    : props.game;
  const multiSelectionProjectionGame = props.game.activePlanetId !== props.multiSelectionReadModel.activePlanetId
    ? { ...props.game, activePlanetId: props.multiSelectionReadModel.activePlanetId as PlanetId }
    : props.game;
  const multiSelectionProjectionReady = multipleSelection && exactNativeMultiSelectionRows(
    multiSelectionProjectionGame,
    props.selectedEntities,
    props.multiSelectedBelts,
    props.multiSelectionReadModel,
  );

  let content: ReactNode;
  if (multipleSelection) {
    content = multiSelectionProjectionReady ? (
      <section
        className="inspector-content native-read-only-multi-selection"
        aria-label="Windows 原生只读多选摘要"
        data-factory-read-model-source="native-core"
        data-factory-read-model-revision={props.multiSelectionReadModel.revision}
      >
        <div className="inspector-identity"><i className="building-mark"><Layers3 size={18} /></i><div><span>Windows 原生只读</span><strong>{props.multiSelectionReadModel.requestedEntityCount} 个建筑 · {props.multiSelectionReadModel.requestedBeltCount} 条线路</strong></div></div>
        <p>多选内容已由同 revision 的 Rust 投影确认；批量修改尚未接入原生命令，因此当前只显示数量，不提供旧 JavaScript 状态操作。</p>
      </section>
    ) : (
      <section className="inspector-content native-read-only-unavailable" aria-label="Windows 原生检查器等待同步" role="status">
        <strong>正在核对原生多选摘要</strong>
        <p>当前 revision 尚未形成完整 Rust 投影，旧 JavaScript 状态不会显示，也不能操作。</p>
      </section>
    );
  } else if (props.selectedEntity && inspectorProjectionReady) {
    content = <DesktopInspectorLiveSummary game={projectionGame} entity={props.selectedEntity} belt={null} readModel={props.inspectorReadModel} />;
  } else if (props.selectedBelt && inspectorProjectionReady) {
    content = <DesktopInspectorLiveSummary game={projectionGame} entity={null} belt={props.selectedBelt} readModel={props.inspectorReadModel} />;
  } else {
    content = (
      <section className="inspector-content native-read-only-unavailable" aria-label="Windows 原生只读检查器" role="status">
        <strong>{props.selectedEntity || props.selectedBelt ? "正在核对原生检查摘要" : "请选择一个建筑或传送带"}</strong>
        <p>这里只显示同 revision 的 Rust 运行摘要；制造、配置、回收和其他旧状态操作均已停用。</p>
      </section>
    );
  }

  return (
    <aside className="inspector-panel native-read-only-inspector" data-native-authority-read-only="true">
      <div className="panel-tabs" role="tablist" aria-label="Windows 原生只读检查器">
        <button role="tab" aria-selected="true" className="active" type="button" disabled>
          <CircuitBoard size={15} /> 检查器
        </button>
      </div>
      {content}
    </aside>
  );
}

function EditableInspectorPanel(props: InspectorPanelProps) {
  const [layoutPreference, setLayoutPreference] = useState(readInspectorLayoutPreference);
  const updateLayoutPreference = (next: InspectorLayoutPreferenceV1) => {
    setLayoutPreference(next);
    writeInspectorLayoutPreference(next);
  };
  const layoutStyle = Object.fromEntries(layoutPreference.order.map((id, index) => [`--inspector-order-${id}`, index + 10])) as CSSProperties;
  return (
    <aside className="inspector-panel">
      <div className="panel-tabs" role="tablist" aria-label="节点与制造视图">
        <button role="tab" aria-selected={props.tab === "inspect"} className={props.tab === "inspect" ? "active" : ""} type="button" onClick={() => props.onTabChange("inspect")}>
          <CircuitBoard size={15} /> 检查器
        </button>
        <button role="tab" aria-selected={props.tab === "fabricate"} className={props.tab === "fabricate" ? "active" : ""} type="button" onClick={() => props.onTabChange("fabricate")}>
          <Wrench size={15} /> 基础制造
        </button>
      </div>
      {props.tab === "fabricate" ? <Fabricator game={props.game} focusItemId={props.fabricatorFocusItemId} onCraft={props.onCraft} onCraftItem={props.onCraftItem} onQueueCraftItem={props.onQueueCraftItem} onCancelCraftQueue={props.onCancelCraftQueue} /> : props.selectedEntities.length > 1 ? (
        <MultiSelectionInspector game={props.game} entities={props.selectedEntities} belts={props.multiSelectedBelts} readModel={props.multiSelectionReadModel} onRecipeChange={props.onBatchRecipeChange} onEjectorOrbitChange={props.onBatchEjectorOrbitChange} onInstallSprayCoater={props.onBatchInstallSprayCoater} onProliferatorConfiguration={props.onBatchProliferatorConfiguration} />
      ) : props.selectedEntity ? (
        <div className={`inspector-entity-shell${props.selectedEntity.interactionLocked ? " inspector-entity-shell--locked" : ""}`} style={layoutStyle} data-collapsed-sections={layoutPreference.collapsed.join(" ")}>
          {props.selectedEntity.interactionLocked ? <div className="inspector-lock-banner"><LockKeyhole size={16} /><span><strong>建筑已锁定</strong><small>模拟与物流继续运行，修改操作已禁用</small></span><button type="button" onClick={() => props.onEntityLockChange(props.selectedEntity!.id, false)}><Unlock size={16} />解锁</button></div> : null}
          <InspectorLayoutControls preference={layoutPreference} onChange={updateLayoutPreference} />
          <fieldset className="inspector-lockable" disabled={props.selectedEntity.interactionLocked}>
          <EntityInspector game={props.game} entity={props.selectedEntity} onRecipeChange={props.onRecipeChange} onEjectorOrbitChange={props.onEjectorOrbitChange} onLogisticsItemChange={props.onLogisticsItemChange} onMaterialDeliverySlotChange={props.onMaterialDeliverySlotChange} onPickEntityInput={props.onPickEntityInput} onOpenOrbitalStation={props.onOpenOrbitalStation} onOrbitalCargoPortClear={props.onOrbitalCargoPortClear} onFuelChange={props.onFuelChange} onEnergyModeChange={props.onEnergyModeChange} onPowerGridChange={props.onPowerGridChange} onPowerPriorityChange={props.onPowerPriorityChange} onGenerationPriorityChange={props.onGenerationPriorityChange} onStationModeChange={props.onStationModeChange} onStationVesselAdjust={props.onStationVesselAdjust} onStationDroneAdjust={props.onStationDroneAdjust} onStationFleetTarget={props.onStationFleetTarget} onStationFleetFill={props.onStationFleetFill} onStationWarperAdjust={props.onStationWarperAdjust} onStationWarpEnabled={props.onStationWarpEnabled} onStationWarperAutoRefillChange={props.onStationWarperAutoRefillChange} onStationWarperTargetChange={props.onStationWarperTargetChange} onStationHubChange={props.onStationHubChange} onStationMinimumLoadChange={props.onStationMinimumLoadChange} onStationSlotItemChange={props.onStationSlotItemChange} onStationSlotModeChange={props.onStationSlotModeChange} onStationSlotMinimumLoadChange={props.onStationSlotMinimumLoadChange} onStationSlotLimitsChange={props.onStationSlotLimitsChange} onStationSlotPriorityChange={props.onStationSlotPriorityChange} onStationSlotRoutePolicyChange={props.onStationSlotRoutePolicyChange} onStationSlotWarperBudgetChange={props.onStationSlotWarperBudgetChange} onSplitterModeChange={props.onSplitterModeChange} onInstallSprayCoater={props.onInstallSprayCoater} onRemoveSprayCoater={props.onRemoveSprayCoater} onOpenResourceSettings={props.onOpenResourceSettings} onProliferatorConfiguration={props.onProliferatorConfiguration} onSetTarget={props.onEntityStackTarget} onUpgrade={props.onUpgradeEntity} onUpgradeInterstellarStation={props.onUpgradeInterstellarStation} onQuantumAttachment={props.onQuantumAttachment} onOrbitalCollectorQuantumMode={props.onOrbitalCollectorQuantumMode} onRemove={props.onRemoveEntity} onOpenConstructionCenter={props.onOpenConstructionCenter} onGalacticExporterPausedChange={props.onGalacticExporterPausedChange} onBlackHolePausedChange={props.onBlackHolePausedChange} onTimeWarpControllerChange={props.onTimeWarpControllerChange} onTimeWarpEnabledChange={props.onTimeWarpEnabledChange} onTimeWarpRequestedMultiplierChange={props.onTimeWarpRequestedMultiplierChange} onOpenTutorial={props.onOpenTutorial} galacticActivityStatus={props.galacticActivityStatus} />
          </fieldset>
        </div>
      ) : props.selectedBelt ? (
        <BeltInspector game={props.game} belt={props.selectedBelt} hasCopiedConfiguration={props.hasCopiedBeltConfiguration} focused={props.focusedBeltNetworkId === props.selectedBelt.id} onPriorityChange={props.onBeltPriorityChange} onLaneCountChange={props.onBeltLaneCountChange} onStackSizeChange={props.onBeltStackSizeChange} onMonitorChange={props.onBeltMonitorChange} onRouteModeChange={props.onBeltRouteModeChange} onRouteOffsetChange={props.onBeltRouteOffsetChange} onApplyConfigurationToNetwork={props.onApplyBeltConfigurationToNetwork} onFocusNetwork={props.onFocusBeltNetwork} onUpgrade={props.onUpgradeBelt} onUpgradeNetwork={props.onUpgradeBeltNetwork} onCopyConfiguration={props.onCopyBeltConfiguration} onPasteConfiguration={props.onPasteBeltConfiguration} onRemove={props.onRemoveBelt} onRemoveNetwork={props.onRemoveBeltNetwork} />
      ) : <InspectorEmpty game={props.game} onOpenTutorial={props.onOpenTutorial} />}
    </aside>
  );
}

export function InspectorPanel(props: InspectorPanelProps) {
  return props.readOnly
    ? <NativeReadOnlyInspectorPanel {...props} />
    : <EditableInspectorPanel {...props} />;
}

export const CONSTRUCTION_BUILD_ORDER: Array<BuildingId | ConveyorBeltId> = [
  "wind_turbine",
  "solar_panel",
  "geothermal_power_station",
  "thermal_power_plant",
  "mini_fusion_power_plant",
  "artificial_star",
  "accumulator",
  "energy_exchanger",
  "mining_machine",
  "arc_smelter",
  "plane_smelter",
  "assembling_machine_mk1",
  "assembling_machine_mk2",
  "assembling_machine_mk3",
  "matrix_lab",
  "conveyor_belt_mk1",
  "conveyor_belt_mk2",
  "conveyor_belt_mk3",
  "storage_mk1",
  "material_delivery_hub",
  "orbital_cargo_terminal",
  "splitter_4way",
  "storage_tank",
  "oil_extractor",
  "oil_refinery",
  "water_pump",
  "chemical_plant",
  "quantum_chemical_plant",
  "fractionator",
  "miniature_particle_collider",
  "em_rail_ejector",
  "vertical_launching_silo",
  "ray_receiver",
  "planetary_logistics_station",
  "interstellar_logistics_station",
  "space_station_construction_launcher",
  "orbital_collector",
  "construction_center",
  "galactic_material_exporter",
  "micro_black_hole_connector",
  "time_warp_device",
];

export function constructionBuildIcon(id: BuildingId | ConveyorBeltId) {
  if (id === "wind_turbine") return <Wind size={18} />;
  if (id === "solar_panel") return <Sun size={18} />;
  if (id === "geothermal_power_station") return <ThermometerSun size={18} />;
  if (id === "thermal_power_plant") return <Flame size={18} />;
  if (id === "mini_fusion_power_plant") return <Atom size={18} />;
  if (id === "artificial_star") return <Sun size={18} />;
  if (id === "accumulator") return <BatteryFull size={18} />;
  if (id === "energy_exchanger") return <BatteryCharging size={18} />;
  if (id === "mining_machine") return <Pickaxe size={18} />;
  if (id === "matrix_lab") return <FlaskConical size={18} />;
  if (id === "storage_mk1") return <Database size={18} />;
  if (id === "material_delivery_hub") return <PackageOpen size={18} />;
  if (id === "orbital_cargo_terminal") return <Satellite size={18} />;
  if (id === "storage_tank" || id === "oil_extractor" || id === "water_pump") return <Droplets size={18} />;
  if (id === "fractionator") return <Droplets size={18} />;
  if (id === "splitter_4way") return <GitFork size={18} />;
  if (id === "miniature_particle_collider") return <Atom size={18} />;
  if (id === "em_rail_ejector") return <Satellite size={18} />;
  if (id === "vertical_launching_silo") return <Rocket size={18} />;
  if (id === "ray_receiver") return <RadioTower size={18} />;
  if (id === "planetary_logistics_station" || id === "interstellar_logistics_station" || id === "space_station_construction_launcher" || id === "orbital_collector") return <Orbit size={18} />;
  if (id === "construction_center") return <Factory size={18} />;
  if (id === "galactic_material_exporter") return <RadioTower size={18} />;
  if (id === "micro_black_hole_connector") return <Atom size={18} />;
  if (id === "time_warp_device") return <Gauge size={18} />;
  if (isConveyorBeltId(id)) return <Layers3 size={18} />;
  return <Factory size={18} />;
}

interface ConstructionDockProps {
  game: GameState;
  placement: BuildingId | null;
  beltTier: BeltTier;
  beltTierMode: "auto" | "manual";
  placementCount: PlacementCount;
  onPlacementChange: (buildingId: BuildingId | null) => void;
  onBeltTierChange: (tier: BeltTier) => void;
  onBeltTierModeChange: (mode: "auto" | "manual") => void;
  onPlacementCountChange: (count: PlacementCount) => void;
  onOpenFabricator: () => void;
  onCraft: (buildingId: ConstructionId) => void;
  onCraftItem: (recipeId: RecipeId) => void;
  onStowCargo: () => void;
  onMissingCraftNavigate: (buildingId: ConstructionId) => void;
  onDeleteConstruction: (constructionId: ConstructionId) => Promise<boolean>;
}

const PLACEMENT_COUNTS: PlacementCount[] = [1, 2, 5, 10];

type ConstructionCategory = "all" | "recent" | "power" | "production" | "logistics" | "dyson";

const RECENT_CONSTRUCTION_KEY = "dsp-idle-network.recent-construction.v1";
const COMPACT_CONSTRUCTION_KEY = "dsp-idle-network.construction-compact.v1";

function loadRecentConstruction(): Array<BuildingId | ConveyorBeltId> {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_CONSTRUCTION_KEY) ?? "[]") as unknown;
    const catalog = getConstructionCatalogIds();
    return Array.isArray(value) ? value.filter((id): id is BuildingId | ConveyorBeltId => typeof id === "string" && catalog.includes(id as BuildingId | ConveyorBeltId)).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function loadCompactConstruction(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_CONSTRUCTION_KEY) === "true";
  } catch {
    return false;
  }
}

export function ConstructionDock({ game, placement, beltTier, beltTierMode, placementCount, onPlacementChange, onBeltTierChange, onBeltTierModeChange, onPlacementCountChange, onOpenFabricator, onCraft, onCraftItem, onStowCargo, onMissingCraftNavigate, onDeleteConstruction }: ConstructionDockProps) {
  const { isEnglish } = useAppLocale();
  const [category, setCategory] = useState<ConstructionCategory>("all");
  const [recent, setRecent] = useState<Array<BuildingId | ConveyorBeltId>>(loadRecentConstruction);
  const [compact, setCompact] = useState(loadCompactConstruction);
  const [discardMode, setDiscardMode] = useState(false);
  const horizontalPan = useHorizontalPan<HTMLDivElement>();
  const unlockedBuildOrder = useMemo(() => getConstructionCatalogIds().filter((id) => {
    if (id === "orbital_cargo_terminal" && (game.mode !== "normal" || game.orbitalStation.status === "locked")) return false;
    const requiredTechId = getConstructionDefinition(id)?.requiredTechId;
    if (!requiredTechId || isTechnologyCompleted(game, requiredTechId)) return true;
    if ((game.construction[id] ?? 0) > 0) return true;
    if (isConveyorBeltId(id) && game.belts.some((belt) => belt.tier === getBeltTier(id))) return true;
    if (id === "mining_machine" && game.entities.some((entity) => entity.minerCount > 0)) return true;
    if (!isConveyorBeltId(id) && game.entities.some((entity) => entity.buildingId === id)) return true;
    return false;
  }), [game.construction, game.belts, game.entities, game.mode, game.orbitalStation.status, game.research.completedTechIds]);
  const visibleBuildOrder = useMemo(() => category === "all"
    ? (discardMode ? unlockedBuildOrder : unlockedBuildOrder.filter(isConstructionDeployable))
    : category === "recent"
      ? recent.filter((id) => unlockedBuildOrder.includes(id) && (discardMode || isConstructionDeployable(id)))
      : unlockedBuildOrder.filter((id) => (discardMode || isConstructionDeployable(id)) && isConstructionInCategory(id, category)), [category, discardMode, recent, unlockedBuildOrder]);
  const visibleFleetItems = useMemo(() => category === "all" || category === "logistics"
    ? PORTABLE_FLEET_ITEM_IDS.filter((itemId) => {
        const recipe = getRecipe(itemId);
        return (game.portableFleet?.[itemId] ?? 0) > 0 || !recipe?.requiredTechId || isTechnologyCompleted(game, recipe.requiredTechId);
      })
    : [], [category, game.portableFleet, game.research.completedTechIds]);
  const visibleConstructionPlans = useMemo(() => new Map(visibleBuildOrder.map((id) => [
    id,
    getConstructionQuickCraftPlan(game, id),
  ])), [visibleBuildOrder, game.research.completedTechIds, game.tray, game.portableFleet]);
  const fleetCraftability = useMemo(() => new Map(PORTABLE_FLEET_ITEM_IDS.map((itemId) => {
    const recipe = getRecipe(itemId);
    return [itemId, recipe ? getRecursiveHandcraftPlan(game, recipe.id, 1).possible : false] as const;
  })), [game.research.completedTechIds, game.tray, game.portableFleet]);
  const remember = (id: BuildingId | ConveyorBeltId) => {
    setRecent((current) => {
      const next = [id, ...current.filter((candidate) => candidate !== id)].slice(0, 8);
      try { window.localStorage.setItem(RECENT_CONSTRUCTION_KEY, JSON.stringify(next)); } catch { /* optional convenience state */ }
      return next;
    });
  };
  const toggleCompact = () => {
    setCompact((current) => {
      const next = !current;
      try { window.localStorage.setItem(COMPACT_CONSTRUCTION_KEY, String(next)); } catch { /* optional convenience state */ }
      return next;
    });
  };
  return (
    <footer className={`construction-dock${compact ? " construction-dock--compact" : ""}`}>
      <div className="dock-label">
        <div className="dock-summary">
          <span>施工托盘</span>
          <strong>{formatQuantityCompact(Object.values(game.construction).reduce<number>((sum, amount) => sum + (amount ?? 0), 0) + Object.values(game.portableFleet ?? {}).reduce<number>((sum, amount) => sum + (amount ?? 0), 0))}</strong>
        </div>
        <select className="dock-category-select" value={category} onChange={(event) => setCategory(event.target.value as ConstructionCategory)} aria-label="施工托盘分类">
          <option value="all">全部设备</option>
          <option value="recent" disabled={recent.length === 0}>最近使用</option>
          <option value="power">能源</option>
          <option value="production">生产</option>
          <option value="logistics">物流</option>
          <option value="dyson">戴森工程</option>
        </select>
        <div className="dock-mode-buttons">
          <button className="dock-compact-toggle" type="button" aria-pressed={compact} onClick={toggleCompact} title={compact ? "恢复标准施工托盘" : "使用两行精简施工托盘"} aria-label={compact ? "关闭施工托盘精简模式" : "开启施工托盘精简模式"}>{compact ? <Rows3 size={12} /> : <LayoutGrid size={12} />}<span>{compact ? "标准" : "精简"}</span></button>
          <button className={`dock-belt-auto${beltTierMode === "auto" ? " active" : ""}`} type="button" aria-pressed={beltTierMode === "auto"} onClick={() => onBeltTierModeChange("auto")} title={isEnglish ? `Automatically use the highest belt tier in inventory; current: Mk.${beltTierRoman(beltTier)}` : `自动使用现有库存中的最高等级传送带，当前 Mk.${beltTierRoman(beltTier)}`}><Route size={12} /><span>{isEnglish ? "Auto" : "自动"} Mk.{beltTierRoman(beltTier)}</span></button>
          <button className={`dock-remove-mode${discardMode ? " active" : ""}`} type="button" aria-pressed={discardMode} onClick={() => { setDiscardMode((enabled) => !enabled); onPlacementChange(null); }} title={discardMode ? "退出施工库存删除模式" : "选择一个施工托盘物品并删除全部库存"} aria-label={discardMode ? "退出施工库存删除模式" : "进入施工库存删除模式"}><Trash2 size={12} /><span>{discardMode ? "退出删除" : "删除"}</span></button>
        </div>
        <div className="placement-count" aria-label="批量部署数量">
          {PLACEMENT_COUNTS.map((count) => (
            <button className={placementCount === count ? "active" : ""} type="button" key={count} aria-pressed={placementCount === count} onClick={() => onPlacementCountChange(count)}>×{count}</button>
          ))}
        </div>
      </div>
      <div ref={horizontalPan.surfaceRef} className={`construction-items${horizontalPan.isPanning ? " horizontal-pan--active" : ""}`} {...horizontalPan.bindings}>
        {visibleBuildOrder.map((id) => {
          const count = game.construction[id] ?? 0;
          const isBelt = isConveyorBeltId(id);
          const itemBeltTier = isBelt ? getBeltTier(id) : null;
          const active = !discardMode && (isBelt ? beltTierMode === "manual" && beltTier === itemBeltTier : placement === id);
          const label = isBelt ? `传送带 Mk.${beltTierRoman(itemBeltTier!)}` : getBuilding(id as BuildingId).name;
          const requiredCount = isBelt ? 1 : placementCount;
          const activePlanet = getPlanet(game.activePlanetId);
          const compatiblePlanet = isBelt ? activePlanet.kind !== "gas-giant" : canPlaceBuildingOnPlanet(id as BuildingId, game.activePlanetId, game);
          const quickCraftPlan = visibleConstructionPlans.get(id) ?? getConstructionQuickCraftPlan(game, id);
          const craftable = quickCraftPlan.possible;
          const quickCraftState = quickCraftPlan.status;
          const consumptionHint = quickCraftPlan.consumedItems.map((item) => `${getItem(item.itemId).name}×${formatQuantityCompact(item.amount)}`).join("、");
          const craftDeficits = craftable ? null : quickCraftPlan;
          const craftHint = craftable
            ? quickCraftPlan.usesUpstream
              ? `一键合成上游材料并制造${label}${consumptionHint ? ` · 消耗${consumptionHint}` : ""}`
              : `制造${label}${consumptionHint ? ` · 消耗${consumptionHint}` : ""}`
            : [
                quickCraftPlan.blocker ? `缓存安全上限：${getItem(quickCraftPlan.blocker.itemId).name} ${quickCraftPlan.blocker.expected}/${quickCraftPlan.blocker.limit}` : null,
                craftDeficits?.missingTechnology ? `科技：${craftDeficits.missingTechnology}` : null,
                ...(craftDeficits?.missingItems.map((item) => `${getItem(item.itemId).name} ${formatQuantityCompact(item.current)}/${formatQuantityCompact(item.required)}（缺 ${formatQuantityCompact(item.missing)}）`) ?? []),
              ].filter(Boolean).join(" · ") || `无法制造${label}`;
          return (
            <div className={`construction-item-shell${active ? " construction-item-shell--active" : ""}`} key={id}>
              <button
                className={`construction-item${active ? " construction-item--active" : ""}`}
                type="button"
                disabled={discardMode ? count < 1 : count < requiredCount || !compatiblePlanet}
                draggable={!discardMode && count >= requiredCount && compatiblePlanet && !isBelt}
                onClick={() => {
                  if (discardMode) {
                    if (count < 1) return;
                    void onDeleteConstruction(id).finally(() => setDiscardMode(false));
                    return;
                  }
                  if (count < requiredCount || !compatiblePlanet) return;
                  remember(id);
                  if (isBelt) {
                    onBeltTierModeChange("manual");
                    onBeltTierChange(itemBeltTier!);
                    onPlacementChange(null);
                  } else {
                    onPlacementChange(active ? null : id as BuildingId);
                  }
                }}
                onDragStart={(event) => {
                  if (isBelt) return;
                  event.dataTransfer.setData("application/factory-building", id);
                  event.dataTransfer.effectAllowed = "move";
                  onPlacementChange(id as BuildingId);
                }}
                onDragEnd={() => onPlacementChange(null)}
                title={discardMode ? `删除施工托盘中的全部${label}，当前 ×${count}` : !compatiblePlanet ? id === "geothermal_power_station" ? `${label}只能部署在烬原 II` : activePlanet.kind === "gas-giant" ? `${label}不能部署在气态巨星` : `${label}只能部署在气态巨星` : isBelt ? `选择${label}连接节点端口` : `部署${label}${placementCount > 1 ? ` ×${placementCount}` : ""}`}
              >
                <i>{constructionBuildIcon(id)}</i>
                <span>{label}</span>
                <strong>×{count}</strong>
              </button>
              <button
                className={`construction-item-craft construction-item-craft--${quickCraftState}${craftable ? "" : " construction-item-craft--disabled"}`}
                type="button"
                disabled={discardMode}
                onClick={() => craftable ? onCraft(id) : onMissingCraftNavigate(id)}
                title={craftHint}
                aria-label={`制造${label}`}
                data-craft-state={quickCraftState}
              ><Hammer size={12} /></button>
            </div>
          );
        })}
        {visibleFleetItems.map((itemId: PortableFleetItemId) => {
          const item = getItem(itemId);
          const recipe = getRecipe(itemId)!;
          const count = Math.max(0, Math.floor(game.portableFleet?.[itemId] ?? 0));
          const cargoReady = game.cargo?.itemId === itemId;
          const craftable = fleetCraftability.get(itemId) ?? getRecursiveHandcraftPlan(game, recipe.id, 1).possible;
          const missingTechnology = recipe.requiredTechId && !isTechnologyCompleted(game, recipe.requiredTechId)
            ? getTechnology(recipe.requiredTechId)?.name
            : null;
          const missingItems = recipe.inputs.flatMap((input) => {
            const current = Math.floor(game.tray[input.itemId] ?? 0);
            return current < input.amount ? [`${getItem(input.itemId).name} ${formatQuantityCompact(current)}/${formatQuantityCompact(input.amount)}（缺 ${formatQuantityCompact(input.amount - current)}）`] : [];
          });
          const craftHint = craftable ? `制造${item.name}` : [missingTechnology ? `科技：${missingTechnology}` : null, ...missingItems].filter(Boolean).join(" · ") || `无法制造${item.name}`;
          return <div className={`construction-item-shell construction-item-shell--fleet${cargoReady ? " construction-item-shell--fleet-ready" : ""}`} key={itemId}>
            <button className={`construction-item construction-item--fleet${cargoReady ? " construction-item--fleet-ready" : ""}`} type="button" onClick={() => { if (cargoReady) onStowCargo(); }} title={cargoReady ? `将手中的${item.name}放入随身载具栏` : `${item.name}随玩家跨星球携带，可在物流站检查器中装载`} aria-label={`随身${item.name}，当前 ${count}`}>
              <i>{itemId === "logistics_vessel" ? <Rocket size={18} /> : <Orbit size={18} />}</i>
              <span>{item.name}</span>
              <strong>×{count}</strong>
            </button>
            <button className="construction-item-craft" type="button" disabled={!craftable} onClick={() => onCraftItem(recipe.id)} title={craftHint} aria-label={`制造${item.name}`}><Hammer size={12} /></button>
          </div>;
        })}
      </div>
      <button className="fabricator-command" type="button" onClick={onOpenFabricator} title="打开基础制造">
        <Wrench size={18} />
        <span>基础制造</span>
      </button>
    </footer>
  );
}

export function CargoCursor({ cargo, x, y }: { cargo: CargoStack | null; x: number; y: number }) {
  if (!cargo) return null;
  const item = getItem(cargo.itemId);
  return (
    <div className="cargo-cursor" style={{ transform: `translate3d(${x + 16}px, ${y + 16}px, 0)` }}>
      <ItemGlyph itemId={cargo.itemId} />
      <span>{item.name}</span>
      <strong>×{formatQuantityCompact(cargo.amount)}</strong>
    </div>
  );
}

export function BuildingPlacementCursor({ buildingId, count, x, y }: {
  buildingId: BuildingId | null;
  count: PlacementCount;
  x: number;
  y: number;
}) {
  if (!buildingId) return null;
  const building = getBuilding(buildingId);
  const previewTiles = Array.from({ length: count }, (_, index) => index);
  return (
    <div className="building-placement-cursor" style={{ transform: `translate3d(${x + 16}px, ${y + 16}px, 0)` }}>
      <div className="building-placement-array" aria-hidden="true">
        {previewTiles.map((index) => <i key={index}>{constructionBuildIcon(buildingId)}</i>)}
      </div>
      <span>{building.name}</span>
      <strong>阵列 ×{count}</strong>
    </div>
  );
}

export function HeaderControls({
  game,
  runStatus,
  onReturnToMenu,
  onPauseToggle,
  pauseControlAvailable = true,
  onOpenResources,
  onOpenInspector,
  onOpenBlueprints,
  onOpenRecipes,
  onOpenTechnology,
  onOpenStatistics,
  onOpenStarMap,
  onOpenSettings,
  onOpenGalaxy,
  onOpenCampaign,
  onOpenConstructionCenter,
  constructionCenterVisible,
  constructionCenterUnavailable = false,
  onOpenDysonPlanner,
  onOpenCommandPalette,
  activeWorkspace,
  showMobileUiSwitch = false,
  onMobileUiSwitch,
}: {
  game: GameState | null;
  runStatus: FactoryRunStatusReadModel;
  onReturnToMenu: () => void;
  onPauseToggle: () => void;
  pauseControlAvailable?: boolean;
  onOpenResources: () => void;
  onOpenInspector: () => void;
  onOpenBlueprints: () => void;
  onOpenRecipes: () => void;
  onOpenTechnology: () => void;
  onOpenStatistics: () => void;
  onOpenStarMap: () => void;
  onOpenSettings: () => void;
  onOpenGalaxy: () => void;
  onOpenCampaign: () => void;
  onOpenConstructionCenter: () => void;
  constructionCenterVisible?: boolean;
  constructionCenterUnavailable?: boolean;
  onOpenDysonPlanner: () => void;
  onOpenCommandPalette: () => void;
  activeWorkspace?: "settings" | "galaxy" | "campaign" | "construction-center" | "star-map" | "statistics" | "recipes" | "technology" | "blueprints" | "dyson" | null;
  showMobileUiSwitch?: boolean;
  onMobileUiSwitch?: () => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const nativeAuthority = game === null;
  const showConstructionCenter = constructionCenterVisible ?? Boolean(
    game?.entities.some((entity) => entity.buildingId === "construction_center"),
  );
  const powerTone = game
    ? game.metrics.powerFactor >= 0.999 ? "positive" : game.metrics.powerFactor > 0 ? "warning" : "negative"
    : "warning";
  const runOverflowAction = (action: () => void) => {
    setOverflowOpen(false);
    action();
  };
  return (
    <header className="game-header">
      <div className="brand-lockup">
        <i><Power size={21} /></i>
        <div><strong>DSP极简网络</strong></div>
      </div>
      <div className="header-metrics">
        {game ? <>
          <div><Zap size={16} /><span>电网负载</span><strong><PowerValue valueKw={game.metrics.demandKw} /><small>/ <PowerValue valueKw={game.metrics.generationKw} /></small></strong></div>
          <div className={`metric-tone metric-tone--${powerTone}`}><Power size={16} /><span>供电效率</span><strong>{Math.round(game.metrics.powerFactor * 100)}<small>%</small></strong></div>
          <div><Factory size={16} /><span>生产通量</span><strong>{game.metrics.totalItemsPerMinute.toFixed(1)}<small>/min</small></strong></div>
          <div><FlaskConical size={16} /><span>蓝 / 红 / 黄 / 紫 / 绿 / 白矩阵</span><strong><QuantityValue value={game.totalProduced.electromagnetic_matrix ?? 0} /><small> / <QuantityValue value={game.totalProduced.energy_matrix ?? 0} /> / <QuantityValue value={game.totalProduced.structure_matrix ?? 0} /> / <QuantityValue value={game.totalProduced.information_matrix ?? 0} /> / <QuantityValue value={game.totalProduced.gravity_matrix ?? 0} /> / <QuantityValue value={game.totalProduced.universe_matrix ?? 0} /></small></strong></div>
        </> : <>
          <div data-native-header-status="factory-run-status-v1"><Power size={16} /><span>Rust 权威</span><strong>{runStatus.paused ? "已暂停" : "运行中"}</strong></div>
          <div><Factory size={16} /><span>当前行星</span><strong>{runStatus.activePlanetId}</strong></div>
          <div><BarChart3 size={16} /><span>状态版本</span><strong>revision {runStatus.revision ?? "-"}</strong></div>
          <div className="metric-tone metric-tone--warning"><Zap size={16} /><span>功率与矩阵</span><strong>等待原生投影</strong></div>
        </>}
      </div>
      <div className="header-actions">
        <button className="header-action--overflowable" type="button" onClick={onReturnToMenu} title="保存并返回主菜单" aria-label="保存并返回主菜单"><House size={17} /></button>
        {!nativeAuthority ? <button className={`header-action--overflowable header-settings-command${activeWorkspace === "settings" ? " active" : ""}`} type="button" onClick={onOpenSettings} title={activeWorkspace === "settings" ? "设置已打开，再次点击返回工厂" : "打开设置"} aria-label={activeWorkspace === "settings" ? "设置已打开，再次点击返回工厂" : "打开设置"} aria-pressed={activeWorkspace === "settings"}>
          <Settings size={17} />
        </button> : null}
        {!nativeAuthority ? <button className={`header-action--overflowable${activeWorkspace === "galaxy" ? " active" : ""}`} type="button" onClick={onOpenGalaxy} title={activeWorkspace === "galaxy" ? "银河网络已打开，再次点击返回工厂" : "打开银河网络"} aria-label={activeWorkspace === "galaxy" ? "银河网络已打开，再次点击返回工厂" : "打开银河网络"} aria-pressed={activeWorkspace === "galaxy"}><Globe2 size={17} /></button> : null}
        {!nativeAuthority ? <button className={`header-action--overflowable${activeWorkspace === "campaign" ? " active" : ""}`} type="button" onClick={onOpenCampaign} title={activeWorkspace === "campaign" ? "主线任务已打开，再次点击返回工厂" : "打开主线任务中心"} aria-label={activeWorkspace === "campaign" ? "主线任务已打开，再次点击返回工厂" : "打开主线任务中心"} aria-pressed={activeWorkspace === "campaign"}><Flag size={17} /></button> : null}
        {showConstructionCenter ? <button className={`header-action--overflowable${activeWorkspace === "construction-center" ? " active" : ""}`} type="button" onClick={onOpenConstructionCenter} disabled={constructionCenterUnavailable} title={constructionCenterUnavailable ? "建筑制造中心当前不可用" : activeWorkspace === "construction-center" ? "建筑制造中心已打开，再次点击返回工厂" : "打开建筑制造中心"} aria-label={constructionCenterUnavailable ? "建筑制造中心当前不可用" : activeWorkspace === "construction-center" ? "建筑制造中心已打开，再次点击返回工厂" : "打开建筑制造中心"} aria-pressed={activeWorkspace === "construction-center"}><Factory size={17} /></button> : null}
        <button className={`header-action--overflowable${activeWorkspace === "star-map" ? " active" : ""}`} type="button" onClick={onOpenStarMap} title={activeWorkspace === "star-map" ? "星图已打开，再次点击返回工厂" : "打开星图"} aria-label={activeWorkspace === "star-map" ? "星图已打开，再次点击返回工厂" : "打开星图"} aria-pressed={activeWorkspace === "star-map"}><Telescope size={17} /></button>
        <button className={`header-action--overflowable${activeWorkspace === "statistics" ? " active" : ""}`} type="button" onClick={onOpenStatistics} title={activeWorkspace === "statistics" ? "生产统计已打开，再次点击返回工厂" : "打开生产统计"} aria-label={activeWorkspace === "statistics" ? "生产统计已打开，再次点击返回工厂" : "打开生产统计"} aria-pressed={activeWorkspace === "statistics"}><BarChart3 size={17} /></button>
        <button className={`header-action--overflowable${activeWorkspace === "blueprints" ? " active" : ""}`} type="button" onClick={onOpenBlueprints} title={activeWorkspace === "blueprints" ? "蓝图工作区已打开，再次点击返回工厂" : "打开蓝图工作区"} aria-label={activeWorkspace === "blueprints" ? "蓝图工作区已打开，再次点击返回工厂" : "打开蓝图工作区"} aria-pressed={activeWorkspace === "blueprints"}><Layers3 size={17} /></button>
        <button className={`header-action--overflowable${activeWorkspace === "recipes" ? " active" : ""}`} type="button" onClick={onOpenRecipes} title={activeWorkspace === "recipes" ? "生产资料库已打开，再次点击返回工厂" : "打开生产资料库"} aria-label={activeWorkspace === "recipes" ? "生产资料库已打开，再次点击返回工厂" : "打开生产资料库"} aria-pressed={activeWorkspace === "recipes"}><BookOpen size={17} /></button>
        <button className={`header-action--overflowable${activeWorkspace === "technology" ? " active" : ""}`} type="button" onClick={onOpenTechnology} title={activeWorkspace === "technology" ? "科技树已打开，再次点击返回工厂" : "打开科技树"} aria-label={activeWorkspace === "technology" ? "科技树已打开，再次点击返回工厂" : "打开科技树"} aria-pressed={activeWorkspace === "technology"}><FlaskConical size={17} /></button>
        <button className="header-action--overflowable header-command-action" type="button" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onOpenCommandPalette(); }} title="打开命令面板（Ctrl/⌘+K）" aria-label="打开命令面板" aria-keyshortcuts="Control+K Meta+K"><Command size={17} /></button>
        {showMobileUiSwitch && onMobileUiSwitch ? <button className="header-mobile-ui-command" type="button" onClick={onMobileUiSwitch} title="体验新版手机界面" aria-label="体验新版手机界面"><Sparkles size={17} /></button> : null}
        <button className="header-overflow-command" type="button" onClick={() => setOverflowOpen((open) => !open)} aria-expanded={overflowOpen} title="更多工作区" aria-label="更多工作区"><MoreHorizontal size={18} /></button>
        {overflowOpen ? <div className="header-overflow-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => runOverflowAction(onReturnToMenu)}><House size={15} />主菜单</button>
          {!nativeAuthority ? <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenSettings)}><Settings size={15} />设置</button> : null}
          {!nativeAuthority ? <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenGalaxy)}><Globe2 size={15} />银河网络</button> : null}
          {!nativeAuthority ? <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenCampaign)}><Flag size={15} />主线任务</button> : null}
          {showConstructionCenter ? <button type="button" role="menuitem" disabled={constructionCenterUnavailable} onClick={() => runOverflowAction(onOpenConstructionCenter)}><Factory size={15} />建筑制造中心{constructionCenterUnavailable ? "（当前不可用）" : ""}</button> : null}
          <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenStarMap)}><Telescope size={15} />星图</button>
          <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenStatistics)}><BarChart3 size={15} />生产统计</button>
          <button type="button" role="menuitem" aria-pressed={activeWorkspace === "blueprints"} onClick={() => runOverflowAction(onOpenBlueprints)}><Layers3 size={15} />蓝图工作区</button>
          <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenRecipes)}><BookOpen size={15} />生产资料库</button>
          <button type="button" role="menuitem" onClick={() => runOverflowAction(onOpenTechnology)}><FlaskConical size={15} />科技树</button>
          <button type="button" role="menuitem" aria-pressed={activeWorkspace === "dyson"} onClick={() => runOverflowAction(onOpenDysonPlanner)}><Orbit size={15} />戴森球规划</button>
          {showMobileUiSwitch && onMobileUiSwitch ? <button type="button" role="menuitem" onClick={() => runOverflowAction(onMobileUiSwitch)}><Sparkles size={15} />新版手机界面</button> : null}
        </div> : null}
        {game ? <button className={`mobile-toggle${game.cargo ? " mobile-toggle--cargo" : ""}`} type="button" onClick={onOpenResources} title={game.cargo ? "物资已拿起，打开物资托盘放下" : "物资托盘"} aria-label={game.cargo ? "物资已拿起，打开物资托盘" : "打开物资托盘"}><PackageOpen size={17} /></button> : null}
        <button className="mobile-toggle" type="button" onClick={onOpenInspector} title="检查器" aria-label="打开检查器"><PanelRight size={17} /></button>
        <button type="button" onClick={onPauseToggle} disabled={!pauseControlAvailable} title={!pauseControlAvailable ? "Windows 原生暂停控制正在等待权威状态" : `${runStatus.paused ? "继续模拟" : "暂停模拟"}（Space）`} aria-label={!pauseControlAvailable ? "Windows 原生暂停控制暂不可用" : runStatus.paused ? "继续模拟" : "暂停模拟"} aria-keyshortcuts="Space">
          {runStatus.paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
      </div>
    </header>
  );
}
