import {
  Atom,
  BatteryCharging,
  BatteryFull,
  Database,
  Droplets,
  Factory,
  Flame,
  FlaskConical,
  Gauge,
  GitFork,
  Hand,
  Lock,
  Orbit,
  Pickaxe,
  RadioTower,
  Route,
  Rocket,
  Satellite,
  Sparkles,
  Sun,
  ThermometerSun,
  Wind,
  Zap,
} from "lucide-react";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { FUEL_ENERGY_MJ, ITEMS, MATRIX_ITEM_IDS, getBuilding, getExtractorBuildingId, getFuelItemIdsForBuilding, getItem, getProliferator, getRecipe, getRecipesForBuilding } from "../game/content";
import { MATERIAL_DELIVERY_SLOT_COUNT, getEntityProliferatorItemId, getEntityProliferatorPowerMultiplier, getEntityProliferatorSpeedMultiplier, getMaterialDeliveryItems, getMaterialDeliverySlots, getStationDroneCapacity, getStationSlots, getStationVesselCapacity, type ResourceReserveSnapshot } from "../game/engine";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { RecipeCatalogPicker } from "./CatalogPicker";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import { isElevatorStation } from "../game/systemHubLogistics";
import { PowerValue } from "./PowerValue";
import { ACTIVITY_MATERIAL_IDS } from "../game/activity";
import type { WorkProgressMode } from "../game/productionRefresh";
import { useWorkDisplayProgress } from "../hooks/useProductionVisualClock";
import type {
  BuildingId,
  CargoStack,
  DraggedItemSourceKind,
  DysonSwarmState,
  DysonSphereState,
  EntityKind,
  EntityOperatingStatus,
  EnergyMode,
  FactoryEntity,
  ItemAmount,
  ItemId,
  PlacementCount,
  RecipeId,
  TechId,
} from "../game/types";
import type { CanvasLod } from "../game/canvasPerformance";

export interface FactoryNodeData extends Record<string, unknown> {
  visualSignature: string;
  presentationSignature: string;
  entity: FactoryEntity;
  cargo: CargoStack | null;
  placement: BuildingId | null;
  placementCount: PlacementCount;
  miningEntityId: string | null;
  onMiningStart: (entityId: string) => void;
  onMiningStop: () => void;
  onPickOutput: (entityId: string, itemId: ItemId) => void;
  onPickInput: (entityId: string, itemId: ItemId) => void;
  onDropCargo: (entityId: string) => void;
  onDropDraggedItem: (targetEntityId: string, itemId: ItemId, sourceKind: DraggedItemSourceKind, sourceId?: string) => void;
  onInstallMiner: (entityId: string, count: PlacementCount) => void;
  onAddBuilding: (entityId: string, buildingId: BuildingId, count: PlacementCount) => void;
  onRecipeChange: (entityId: string, recipeId: RecipeId) => void;
  onFuelChange: (entityId: string, itemId: ItemId) => void;
  onEnergyModeChange: (entityId: string, mode: EnergyMode) => void;
  onInteractionLockChange: (entityId: string, locked: boolean) => void;
  researchLabel: string | null;
  researchCosts: ItemAmount[];
  connectedInputItemIds: readonly ItemId[];
  inputBeltCounts: Partial<Record<ItemId, number>>;
  outputBeltCounts: Partial<Record<ItemId, number>>;
  blackHolePortConnections: Partial<Record<0 | 1 | 2, ItemId>>;
  completedTechIds: TechId[];
  paused: boolean;
  powerFactor: number;
  resourceReserve: ResourceReserveSnapshot | null;
  powerDemandMultiplier: number;
  solarGenerationMultiplier: number;
  windGenerationMultiplier: number;
  geothermalGenerationMultiplier: number;
  activeLogisticsEntityIds: string[];
  connectionDraft: { nodeId: string; handleId: string; itemId: ItemId | null; handleType: "source" | "target" } | null;
  dysonSwarm: DysonSwarmState;
  dysonSphere: DysonSphereState;
  targetDysonOrbitLabel?: string;
  timeWarp: import("../game/types").TimeWarpState;
  simulationMultiplier: number;
  status: EntityOperatingStatus;
  outputCapacity: number;
  cycleRatePerSecond: number;
  lod: CanvasLod;
  extremeVisuals: boolean;
  acceptedInputItemIds: readonly ItemId[];
  producedOutputItemIds: readonly ItemId[];
  connectionViewportFull: boolean;
}

export type FactoryFlowNode = Node<FactoryNodeData, EntityKind>;

function useDynamicHandles(entityId: string, signature: string): RefObject<HTMLElement | null> {
  const updateNodeInternals = useUpdateNodeInternals();
  const nodeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let frame = window.requestAnimationFrame(() => updateNodeInternals(entityId));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => updateNodeInternals(entityId));
    });
    if (nodeRef.current) observer?.observe(nodeRef.current);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [entityId, signature, updateNodeInternals]);
  return nodeRef;
}

function ItemBadge({ itemId, amount, muted = false }: { itemId: ItemId; amount: number; muted?: boolean }) {
  const item = getItem(itemId);
  return (
    <ItemHoverCard itemId={itemId} className="item-reference--badge">
      <span className={`item-badge${muted ? " item-badge--muted" : ""}`} title={formatQuantityExact(amount)} aria-label={`${item.name} ${formatQuantityExact(amount)}`}>
        <ItemGlyph itemId={itemId} />
        <span>{item.name}</span>
        <strong>{formatQuantityCompact(amount)}</strong>
      </span>
    </ItemHoverCard>
  );
}

function InteractionLockBadge({ entity, onChange }: { entity: FactoryEntity; onChange: FactoryNodeData["onInteractionLockChange"] }) {
  if (!entity.interactionLocked) return null;
  return <button
    className="factory-node__lock nodrag nopan"
    type="button"
    title="建筑已锁定，点击解锁"
    aria-label="建筑已锁定，点击解锁"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      onChange(entity.id, false);
    }}
  ><Lock size={14} /></button>;
}

function WorkCycle({
  label,
  progress,
  active,
  efficiency,
  cyclesPerSecond = 0,
  mode = "cycle",
  semanticKey = label,
  effectiveSimulationMultiplier = 1,
}: {
  label: string;
  progress: number;
  active: boolean;
  efficiency: number;
  cyclesPerSecond?: number;
  mode?: WorkProgressMode;
  semanticKey?: string;
  effectiveSimulationMultiplier?: number;
}) {
  const normalized = Math.max(0, Math.min(1, progress));
  const displayProgress = useWorkDisplayProgress({
    mode,
    semanticKey,
    snapshotProgress: normalized,
    cyclesPerSecond,
    effectiveSimulationMultiplier,
    active,
  });
  const percent = Math.round(displayProgress * 100);
  if (mode === "indeterminate") {
    return <div className={`work-cycle work-cycle--indeterminate${active ? " work-cycle--active" : ""}`} aria-label={`${label} ${active ? "运行中" : "待机"}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
      <strong>{active ? "运行中" : "待机"}</strong>
    </div>;
  }
  return (
    <div
      className={`work-cycle work-cycle--${mode}${active ? " work-cycle--active" : ""}${active && cyclesPerSecond > 0 ? " work-cycle--interpolated" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i style={{ transform: `scaleX(${displayProgress})` }} />
      <span>{label}</span>
      <strong>{active ? `${percent}% · 效率 ${Math.round(efficiency * 100)}%` : percent > 0 ? `${percent}% · 暂停` : "待机"}</strong>
    </div>
  );
}

interface OutputSlotProps {
  entityId: string;
  itemId: ItemId;
  amount: number;
  onPick: (entityId: string, itemId: ItemId) => void;
  connectionDraft: FactoryNodeData["connectionDraft"];
  connectionCount?: number;
}

function connectionHandleClass(entityId: string, itemId: ItemId, handleType: "source" | "target", draft: FactoryNodeData["connectionDraft"]): string {
  if (!draft) return "";
  if (draft.nodeId === entityId && draft.itemId === itemId && draft.handleType === handleType) return " factory-handle--origin";
  if (draft.handleType === handleType) return " factory-handle--muted";
  return draft.itemId === null || draft.itemId === itemId ? " factory-handle--compatible" : " factory-handle--incompatible";
}

function OutputSlot({ entityId, itemId, amount, onPick, connectionDraft, connectionCount = 0 }: OutputSlotProps) {
  const enabled = amount > 0.001;
  const previousAmountRef = useRef(Math.floor(amount));
  const [outputPulse, setOutputPulse] = useState(0);
  useEffect(() => {
    const current = Math.floor(amount);
    if (current > previousAmountRef.current) setOutputPulse((pulse) => pulse + 1);
    previousAmountRef.current = current;
  }, [amount]);
  const pick = () => enabled && onPick(entityId, itemId);
  return (
    <div className={`node-port node-port--output${outputPulse > 0 ? " node-port--output-pulse" : ""}`}>
      <button
        className="node-slot nodrag nopan"
        type="button"
        disabled={!enabled}
        draggable={enabled}
        onClick={(event) => { event.stopPropagation(); pick(); }}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData("application/factory-item", itemId);
          event.dataTransfer.setData("application/factory-source-kind", "node");
          event.dataTransfer.setData("application/factory-source-id", entityId);
          event.dataTransfer.effectAllowed = "move";
        }}
        title={`拿取${ITEMS[itemId].name}`}
      >
        <ItemBadge itemId={itemId} amount={amount} muted={!enabled} />
      </button>
      {outputPulse > 0 ? <b className="node-output-pulse" key={outputPulse} aria-hidden="true">+{ITEMS[itemId].symbol}</b> : null}
      {connectionCount > 0 ? <span className="node-port__connections" title={`${connectionCount} 条输出线路`}>{connectionCount}</span> : null}
      <Handle id={`out:${itemId}`} type="source" position={Position.Right} className={`factory-handle factory-handle--output nodrag nopan${connectionHandleClass(entityId, itemId, "source", connectionDraft)}`} />
    </div>
  );
}

interface InputSlotProps {
  entityId: string;
  itemId: ItemId;
  amount: number;
  cargo: CargoStack | null;
  onDropCargo: (entityId: string) => void;
  onPickInput: (entityId: string, itemId: ItemId) => void;
  onDropDraggedItem: FactoryNodeData["onDropDraggedItem"];
  connectionDraft: FactoryNodeData["connectionDraft"];
  connectionCount?: number;
  missing?: boolean;
  handleId?: string;
}

function InputSlot({ entityId, itemId, amount, cargo, onDropCargo, onPickInput, onDropDraggedItem, connectionDraft, connectionCount = 0, missing = false, handleId }: InputSlotProps) {
  const compatible = cargo?.itemId === itemId;
  const previousAmountRef = useRef(Math.floor(amount));
  const [arrivalPulse, setArrivalPulse] = useState(0);
  useEffect(() => {
    const current = Math.floor(amount);
    if (current > previousAmountRef.current) setArrivalPulse((pulse) => pulse + 1);
    previousAmountRef.current = current;
  }, [amount]);
  const dropCargo = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (compatible) onDropCargo(entityId);
    else if (!cargo && amount >= 1) onPickInput(entityId, itemId);
  };
  const dropDragged = (event: React.DragEvent) => {
    const draggedItem = event.dataTransfer.getData("application/factory-item") as ItemId;
    if (draggedItem !== itemId) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceKind = event.dataTransfer.getData("application/factory-source-kind") as DraggedItemSourceKind;
    const sourceId = event.dataTransfer.getData("application/factory-source-id") || undefined;
    onDropDraggedItem(entityId, draggedItem, sourceKind, sourceId);
  };
  return (
    <div className={`node-port node-port--input${compatible ? " node-port--compatible" : ""}${missing ? " node-port--missing" : ""}${arrivalPulse > 0 ? " node-port--arrival" : ""}`}>
      <Handle id={handleId ?? `in:${itemId}`} type="target" position={Position.Left} className={`factory-handle factory-handle--input nodrag nopan${connectionHandleClass(entityId, itemId, "target", connectionDraft)}`} />
      <button
        className="node-slot nodrag nopan"
        type="button"
        draggable={amount >= 1}
        onClick={dropCargo}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData("application/factory-item", itemId);
          event.dataTransfer.setData("application/factory-source-kind", "node-input");
          event.dataTransfer.setData("application/factory-source-id", entityId);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/factory-item")) event.preventDefault();
        }}
        onDrop={dropDragged}
        title={compatible ? `投入${ITEMS[itemId].name}` : amount >= 1 && !cargo ? `取出${ITEMS[itemId].name}` : `投入${ITEMS[itemId].name}`}
      >
        <ItemBadge itemId={itemId} amount={amount} muted={amount <= 0.001} />
      </button>
      {arrivalPulse > 0 ? <b className="node-input-arrival" key={arrivalPulse} aria-hidden="true" /> : null}
      {connectionCount > 0 ? <span className="node-port__connections" title={`${connectionCount} 条输入线路`}>{connectionCount}</span> : null}
    </div>
  );
}

function AutoInputPort({ connectionDraft, label = "自动匹配", handleId = "in:auto" }: {
  connectionDraft: FactoryNodeData["connectionDraft"];
  label?: string;
  handleId?: string;
}) {
  const compatible = connectionDraft?.handleType === "source";
  const muted = connectionDraft?.handleType === "target";
  return (
    <div className={`node-auto-input${compatible ? " node-auto-input--compatible" : ""}${muted ? " node-auto-input--muted" : ""}`}>
      <Handle id={handleId} type="target" position={Position.Left} className="factory-handle factory-handle--input factory-handle--auto nodrag nopan" />
      <Sparkles size={11} /><span>{label}</span>
    </div>
  );
}

function uniqueItemIds(...groups: readonly (readonly ItemId[])[]): ItemId[] {
  return [...new Set(groups.flat())];
}

function LightweightNodeHandles({ data }: { data: FactoryNodeData }) {
  const { entity } = data;
  const specialInputs = entity.buildingId === "material_delivery_hub"
    ? (entity.deliverySlots ?? []).flatMap((slot, index) => slot.mode === "disabled" ? [] : [{ id: `in:delivery:${index}`, itemId: slot.itemId }])
    : entity.buildingId === "micro_black_hole_connector"
      ? ([0, 1, 2] as const).map((index) => ({ id: `in:black-hole:${index}`, itemId: data.blackHolePortConnections[index] }))
      : [];
  // Machine ports are defined by the active recipe. A stale legacy line must
  // not manufacture an extra visual port while storage migration repairs it.
  const inputItems = entity.kind === "machine"
    ? uniqueItemIds(data.acceptedInputItemIds)
    : uniqueItemIds(data.acceptedInputItemIds, Object.keys(data.inputBeltCounts) as ItemId[]);
  const outputItems = entity.kind === "machine"
    ? uniqueItemIds(data.producedOutputItemIds)
    : uniqueItemIds(data.producedOutputItemIds, Object.keys(data.outputBeltCounts) as ItemId[]);
  const showAutoInput = specialInputs.length === 0 && inputItems.length === 0;
  const inputCount = specialInputs.length || inputItems.length || (showAutoInput ? 1 : 0);
  const position = (index: number, count: number) => `${((index + 1) / (count + 1)) * 100}%`;
  return <>
    {specialInputs.length > 0 ? specialInputs.map((port, index) => <Handle
      id={port.id}
      type="target"
      position={Position.Left}
      style={{ top: position(index, specialInputs.length) }}
      className={`factory-handle factory-handle--input factory-node-lod__handle nodrag nopan${port.itemId ? connectionHandleClass(entity.id, port.itemId, "target", data.connectionDraft) : " factory-handle--universal"}`}
      key={port.id}
    />) : inputItems.map((itemId, index) => <Handle
      id={`in:${itemId}`}
      type="target"
      position={Position.Left}
      style={{ top: position(index, inputCount) }}
      className={`factory-handle factory-handle--input factory-node-lod__handle nodrag nopan${connectionHandleClass(entity.id, itemId, "target", data.connectionDraft)}`}
      key={`in:${itemId}`}
    />)}
    {showAutoInput ? <Handle id="in:auto" type="target" position={Position.Left} className="factory-handle factory-handle--input factory-handle--auto factory-node-lod__handle nodrag nopan" /> : null}
    {outputItems.map((itemId, index) => <Handle
      id={`out:${itemId}`}
      type="source"
      position={Position.Right}
      style={{ top: position(index, outputItems.length) }}
      className={`factory-handle factory-handle--output factory-node-lod__handle nodrag nopan${connectionHandleClass(entity.id, itemId, "source", data.connectionDraft)}`}
      key={`out:${itemId}`}
    />)}
  </>;
}

function FactoryNodeLodView({ data, selected }: NodeProps<FactoryFlowNode>) {
  const { entity, lod } = data;
  const resource = entity.resourceId ? getItem(entity.resourceId) : null;
  const building = entity.buildingId ? getBuilding(entity.buildingId) : null;
  const recipe = entity.recipeId ? getRecipe(entity.recipeId) : null;
  const productionTitle = entity.recipeId === "matrix_research"
    ? data.researchLabel ?? "科研模式"
    : recipe?.name ?? (recipe?.outputs[0] ? getItem(recipe.outputs[0].itemId).name : entity.kind === "machine" ? "未设置配方" : null);
  const name = resource?.name ?? (productionTitle && entity.kind !== "station" && entity.kind !== "storage" && entity.kind !== "splitter" ? productionTitle : building?.name) ?? "工厂节点";
  const category = entity.kind === "vein" ? "资源矿脉" : entity.kind === "power" ? "电力设施" : entity.kind === "station" ? "物流设施" : entity.kind === "storage" ? "仓储设施" : entity.kind === "splitter" ? "分流设施" : "生产设施";
  const count = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
  const icon = entity.kind === "vein" ? <Pickaxe size={18} /> : entity.kind === "power" ? <Zap size={18} /> : entity.kind === "station" ? <Orbit size={18} /> : entity.kind === "storage" ? <Database size={18} /> : entity.kind === "splitter" ? <GitFork size={18} /> : <Factory size={18} />;
  const inputItems = entity.kind === "machine"
    ? uniqueItemIds(data.acceptedInputItemIds)
    : uniqueItemIds(data.acceptedInputItemIds, Object.keys(data.inputBeltCounts) as ItemId[]);
  const outputItems = entity.kind === "machine"
    ? uniqueItemIds(data.producedOutputItemIds)
    : uniqueItemIds(data.producedOutputItemIds, Object.keys(data.outputBeltCounts) as ItemId[]);
  return <article className={`factory-node factory-node-lod factory-node-lod--${lod} factory-node--status-${data.status.tone}${selected ? " factory-node--selected" : ""}${entity.interactionLocked ? " factory-node--locked" : ""}`} data-node-lod={lod}>
    <LightweightNodeHandles data={data} />
    <header className="factory-node__header">
      <div className="node-icon" style={resource ? { color: resource.color } : undefined}>{icon}</div>
      <div><span>{productionTitle && name === productionTitle ? `${productionTitle} · ${building?.name ?? category}` : category}</span><strong title={name}>{name}</strong></div>
      <small>×{count}</small>
    </header>
    {lod === "medium" ? <div className="factory-node-lod__summary">
      <span className={`status-dot status-dot--${data.status.tone === "running" ? "good" : data.status.tone === "warning" ? "partial" : data.status.tone === "blocked" ? "blocked" : "idle"}`} />
      <strong>{data.status.label}</strong>
      <small>{Math.round(data.powerFactor * 100)}% 电力</small>
      <div className="factory-node-lod__io" aria-label="简化输入输出">
        <span>入 {inputItems.slice(0, 3).map((itemId) => ITEMS[itemId]?.symbol ?? "?").join(" ") || "--"}</span>
        <span>出 {outputItems.slice(0, 3).map((itemId) => ITEMS[itemId]?.symbol ?? "?").join(" ") || "--"}</span>
      </div>
    </div> : null}
  </article>;
}

function VeinFullNode({ data, selected }: NodeProps<FactoryFlowNode>) {
  const { entity, cargo, placement } = data;
  const resourceId = entity.resourceId!;
  const resource = getItem(resourceId);
  const mining = data.miningEntityId === entity.id;
  const output = entity.outputs[resourceId] ?? 0;
  const extractorId = getExtractorBuildingId(resourceId);
  const extractor = getBuilding(extractorId);
  const fluid = resource.kind === "fluid";
  const water = resourceId === "water";
  const sulfuricOcean = resourceId === "sulfuric_acid";
  const remote = resourceId === "silicon_ore" || resourceId === "titanium_ore";
  const installing = placement === extractorId;
  const reserve = data.resourceReserve;

  const install = (event: React.MouseEvent) => {
    if (!installing) return;
    event.preventDefault();
    event.stopPropagation();
    data.onInstallMiner(entity.id, data.placementCount);
  };

  return (
    <article
      className={`factory-node vein-node factory-node--status-${data.status.tone}${reserve?.exhausted ? " vein-node--depleted" : ""}${entity.interactionLocked ? " factory-node--locked" : ""}${selected ? " factory-node--selected" : ""}${installing ? " factory-node--placement" : ""}`}
      onClick={install}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/factory-building")) event.preventDefault();
      }}
      onDrop={(event) => {
        const buildingId = event.dataTransfer.getData("application/factory-building") as BuildingId;
        if (buildingId !== extractorId) return;
        event.preventDefault();
        event.stopPropagation();
        data.onInstallMiner(entity.id, data.placementCount);
      }}
    >
      <InteractionLockBadge entity={entity} onChange={data.onInteractionLockChange} />
      <header className="factory-node__header">
        <div className="node-icon" style={{ color: resource.color }}>{fluid ? <Droplets size={18} /> : <Pickaxe size={18} />}</div>
        <div>
          <span>{water ? "海洋水源" : sulfuricOcean ? "硫酸海洋" : fluid ? "原油涌泉" : remote ? "远端矿区" : "资源矿脉"}</span>
          <strong>{resource.name}</strong>
        </div>
        <small className={reserve?.exhausted ? "resource-reserve--depleted" : ""}>{reserve?.infinite ? "∞" : reserve?.exhausted ? "枯竭" : `${reserve?.remainingPercent ?? 0}%`}</small>
      </header>
      <div className="vein-readout">
        <span>{extractor.shortName} <strong>×{entity.minerCount}</strong></span>
        <span title={data.status.label}>{entity.minerCount > 0 ? `${data.status.label} · ${entity.productionRate.toFixed(1)}/min` : data.status.label}</span>
        <span className={reserve?.exhausted ? "vein-reserve vein-reserve--depleted" : "vein-reserve"}>{reserve?.infinite ? "无限储量" : `储量 ${formatQuantityCompact(reserve?.remaining ?? 0)} / ${formatQuantityCompact(reserve?.capacity ?? 0)} · ${reserve?.remainingPercent ?? 0}%`}</span>
      </div>
      {entity.minerCount > 0 ? (
        <WorkCycle label="采矿周期" progress={entity.progress} active={!data.paused && entity.utilization > 0.001} efficiency={data.powerFactor} cyclesPerSecond={data.cycleRatePerSecond} semanticKey={`${entity.id}:${entity.resourceId}`} effectiveSimulationMultiplier={data.simulationMultiplier} />
      ) : null}
      {fluid ? (
        <div className="manual-mine manual-mine--locked"><Droplets size={16} /><span>{entity.minerCount > 0 ? `由${extractor.shortName}自动抽取` : `需要${extractor.name}`}</span></div>
      ) : (
        <button
          className={`manual-mine nodrag nopan${mining ? " manual-mine--active" : ""}`}
          type="button"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onMiningStart(entity.id);
          }}
          onPointerUp={data.onMiningStop}
          onPointerCancel={data.onMiningStop}
          title={`长按采集${resource.name}`}
        >
          <Hand size={16} />
          <span>{mining ? "采集中" : "采集"}</span>
          <i />
        </button>
      )}
      <OutputSlot entityId={entity.id} itemId={resourceId} amount={output} onPick={data.onPickOutput} connectionDraft={data.connectionDraft} connectionCount={data.outputBeltCounts[resourceId] ?? 0} />
      {cargo?.itemId === resourceId ? <span className="node-cargo-match">同类物资已拿起</span> : null}
    </article>
  );
}

function MachineFullNode({ data, selected }: NodeProps<FactoryFlowNode>) {
  const { entity, cargo, placement } = data;
  const building = getBuilding(entity.buildingId!);
  const recipe = getRecipe(entity.recipeId);
  const galacticExporter = entity.buildingId === "galactic_material_exporter";
  const blackHoleConnector = entity.buildingId === "micro_black_hole_connector";
  const timeWarpDevice = entity.buildingId === "time_warp_device";
  const researchInputs = MATRIX_ITEM_IDS.filter((itemId) =>
    data.researchCosts.some((cost) => cost.itemId === itemId) ||
    data.connectedInputItemIds.includes(itemId) ||
    (entity.inputs[itemId] ?? 0) > 0 ||
    data.completedTechIds.includes(itemId as TechId))
    .map((itemId) => ({ itemId, amount: 1 }));
  const recipeInputs = galacticExporter
    ? ACTIVITY_MATERIAL_IDS.map((itemId) => ({ itemId, amount: 1 }))
    : recipe?.id === "matrix_research" ? researchInputs : recipe?.inputs ?? [];
  const proliferatorItemId = entity.sprayCoaterInstalled ? getEntityProliferatorItemId(entity) : undefined;
  const inputs = proliferatorItemId && !recipeInputs.some((input) => input.itemId === proliferatorItemId)
    ? [...recipeInputs, { itemId: proliferatorItemId, amount: 1 }]
    : recipeInputs;
  const outputIds = recipe?.outputs.map((output) => output.itemId) ?? [];
  useDynamicHandles(entity.id, blackHoleConnector
    ? `black-hole:${([0, 1, 2] as const).map((index) => data.blackHolePortConnections[index] ?? "empty").join(",")}`
    : `${inputs.map((input) => input.itemId).join(",")}:auto>${outputIds.join(",")}`);
  const acceptsCargo = cargo && inputs.some((input) => input.itemId === cargo.itemId);
  const adding = placement === entity.buildingId;
  const utilizationTone = data.status.tone === "running" ? "good" : data.status.tone === "warning" ? "partial" : data.status.tone === "blocked" ? "blocked" : "idle";
  const recipeOptions = getRecipesForBuilding(entity.buildingId!).filter((option) =>
    !option.requiredTechId || data.completedTechIds.includes(option.requiredTechId));
  const railEjector = entity.buildingId === "em_rail_ejector";
  const rayReceiver = entity.buildingId === "ray_receiver";
  const launchSilo = entity.buildingId === "vertical_launching_silo";
  const constructionCenter = entity.buildingId === "construction_center";
  const constructionCenterTier = data.completedTechIds.includes("construction_capacity_2")
    ? "III"
    : data.completedTechIds.includes("construction_capacity_1") ? "II" : "I";
  const rayPowerMode = recipe?.id === "ray_power";
  const speedMultiplier = recipe?.id === "matrix_research"
    ? 1 + (data.completedTechIds.includes("research_speed_1") ? 0.25 : 0) +
      (data.completedTechIds.includes("research_speed_2") ? 0.25 : 0) +
      (data.completedTechIds.includes("research_speed_3") ? 0.25 : 0)
    : 1;
  const proliferator = entity.proliferatorTier ? getProliferator(entity.proliferatorTier) : null;
  const proliferatorPoints = proliferator
    ? Math.floor((entity.proliferatorPoints ?? 0) + (entity.inputs[proliferator.itemId] ?? 0) * proliferator.sprayPoints)
    : 0;
  const add = (event: React.MouseEvent) => {
    if (!adding) return;
    event.preventDefault();
    event.stopPropagation();
    data.onAddBuilding(entity.id, entity.buildingId!, data.placementCount);
  };

  return (
    <article
      className={`factory-node machine-node factory-node--status-${data.status.tone}${entity.interactionLocked ? " factory-node--locked" : ""}${constructionCenter || galacticExporter || blackHoleConnector || timeWarpDevice ? " factory-node--megastructure" : ""}${galacticExporter ? " factory-node--galactic-exporter" : ""}${blackHoleConnector ? " factory-node--black-hole" : ""}${timeWarpDevice ? " factory-node--time-warp" : ""}${building.tier && building.tier > 1 ? ` factory-node--tier-${building.tier}` : ""}${selected ? " factory-node--selected" : ""}${adding ? " factory-node--placement" : ""}${acceptsCargo ? " factory-node--accepts-cargo" : ""}${(railEjector || launchSilo) && entity.utilization > 0.001 ? " factory-node--orbital-active" : ""}`}
      onClick={add}
      onDragOver={(event) => {
        if (event.dataTransfer.types.some((type) => type === "application/factory-item" || type === "application/factory-building")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const buildingId = event.dataTransfer.getData("application/factory-building") as BuildingId;
        if (buildingId && buildingId === entity.buildingId) {
          data.onAddBuilding(entity.id, buildingId, data.placementCount);
          return;
        }
        const draggedItem = event.dataTransfer.getData("application/factory-item") as ItemId;
        if (draggedItem) {
          const sourceKind = event.dataTransfer.getData("application/factory-source-kind") as DraggedItemSourceKind;
          const sourceId = event.dataTransfer.getData("application/factory-source-id") || undefined;
          data.onDropDraggedItem(entity.id, draggedItem, sourceKind, sourceId);
        }
      }}
    >
      <InteractionLockBadge entity={entity} onChange={data.onInteractionLockChange} />
      <header className="factory-node__header">
        <div className={`node-icon${rayReceiver ? " node-icon--ray" : railEjector || launchSilo ? " node-icon--orbit" : ""}`}>
          {blackHoleConnector ? <Atom size={18} /> : timeWarpDevice ? <Gauge size={18} /> : galacticExporter ? <Rocket size={18} /> : entity.buildingId === "miniature_particle_collider" ? <Atom size={18} /> : railEjector ? <Satellite size={18} /> : launchSilo ? <Rocket size={18} /> : rayReceiver ? <RadioTower size={18} /> : <Factory size={18} />}
        </div>
        <div>
          <span>{blackHoleConnector ? "永久物资销毁" : timeWarpDevice ? "全局模拟主控" : constructionCenter ? "巨构自动补给" : galacticExporter ? "银河终局工程" : railEjector ? "恒星轨道设施" : launchSilo ? "戴森球建造设施" : rayReceiver ? "戴森系统接收设施" : building.shortName}</span>
          <strong>{constructionCenter || galacticExporter || blackHoleConnector || timeWarpDevice ? building.name : recipe?.name ?? "未指定配方"}</strong>
        </div>
        <small>×{entity.machineCount}</small>
      </header>
      {constructionCenter ? <section className={`construction-center-core construction-center-core--${data.status.tone}`} aria-label={`建筑制造中心 Mk.${constructionCenterTier} ${data.status.label}`}>
        <div className="construction-center-core__reactor" aria-hidden="true"><i /><b><Factory size={34} /></b><span /></div>
        <div className="construction-center-core__identity">
          <span>MEGASTRUCTURE · BUILD ARRAY</span>
          <strong>行星建筑制造阵列 Mk.{constructionCenterTier}</strong>
          <small>从当前行星物资托盘取料，按目标库存持续补足施工设备</small>
        </div>
        <dl>
          <div><dt>运行状态</dt><dd>{data.status.label}</dd></div>
          <div><dt>制造负载</dt><dd>{Math.round(entity.utilization * 100)}%</dd></div>
          <div><dt>当前周期</dt><dd>{Math.round(entity.progress * 100)}%</dd></div>
          <div><dt>阵列等级</dt><dd>Mk.{constructionCenterTier}</dd></div>
        </dl>
      </section> : null}
      {selected && !entity.interactionLocked && !constructionCenter && !galacticExporter && !blackHoleConnector && !timeWarpDevice ? (
        <div className="node-inline-select nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
          <span>生产配方</span>
          <RecipeCatalogPicker value={entity.recipeId} recipes={recipeOptions} onChange={(recipeId) => data.onRecipeChange(entity.id, recipeId)} compact />
        </div>
      ) : null}
      <div className="machine-status">
        <span className={`status-dot status-dot--${utilizationTone}`} />
        <span title={data.status.label}>{data.status.label}</span>
        <strong>{entity.productionRate.toFixed(1)}/min</strong>
      </div>
      {blackHoleConnector ? (
        <section className="black-hole-core" aria-label="微型黑洞物资销毁接口">
          <div className="black-hole-core__warning"><Atom size={16} /><span>输入物资将被永久销毁且无法找回</span></div>
          {([0, 1, 2] as const).map((index) => {
            const port = entity.blackHolePorts?.find((entry) => entry.index === index);
            const itemId = data.blackHolePortConnections[index] ?? port?.currentItemId;
            return <div className="black-hole-port" key={index}>
              <Handle id={`in:black-hole:${index}`} type="target" position={Position.Left} style={{ top: `${47 + index * 15}%` }} className="factory-handle factory-handle--input factory-handle--universal nodrag nopan" />
              <span>接口 {index + 1}</span>
              <strong>{itemId ? getItem(itemId).name : "等待连接"}</strong>
              <small>累计 {formatQuantityCompact(port?.totalDestroyed ?? "0")}</small>
            </div>;
          })}
        </section>
      ) : timeWarpDevice ? (
        <section className="time-warp-core">
          <div><span>{data.timeWarp.controllerEntityId === entity.id ? "主控" : "非主控"}</span><strong>{data.timeWarp.enabled && data.timeWarp.controllerEntityId === entity.id ? `${data.timeWarp.effectiveMultiplier}x` : "已暂停"}</strong></div>
          <div><span>请求倍率</span><strong>{data.timeWarp.requestedMultiplier}x</strong></div>
          <div><span>需求功率</span><strong><PowerValue valueKw={data.timeWarp.requiredPowerKw} /></strong></div>
          <div><span>实际分配</span><strong><PowerValue valueKw={data.timeWarp.allocatedPowerKw} /></strong></div>
        </section>
      ) : rayPowerMode ? (
        <div className="ray-reception">
          <RadioTower size={14} />
          <span>连续接收</span>
          <strong><PowerValue valueKw={entity.powerOutputKw ?? 0} /> · {Math.round(entity.utilization * 100)}%</strong>
        </div>
      ) : (
        <WorkCycle
          label={constructionCenter ? "建筑制造周期" : galacticExporter ? "银河物资交付" : recipe?.id === "matrix_research" ? "科研周期" : railEjector ? "太阳帆发射" : launchSilo ? "火箭发射" : rayReceiver ? "光子周期" : entity.buildingId === "miniature_particle_collider" ? "对撞周期" : entity.buildingId === "oil_refinery" || entity.buildingId === "chemical_plant" ? "加工周期" : "生产周期"}
          progress={entity.progress}
          active={!data.paused && entity.utilization > 0.001}
          efficiency={entity.utilization}
          cyclesPerSecond={data.cycleRatePerSecond}
          semanticKey={`${entity.id}:${recipe?.id ?? "idle"}`}
          effectiveSimulationMultiplier={data.simulationMultiplier}
        />
      )}
      {railEjector || launchSilo ? (
        <div className={`orbital-launch-track${entity.utilization > 0.001 && !data.paused ? " orbital-launch-track--active" : ""}`} aria-hidden="true">
          <span>{railEjector ? "电磁加速轨" : "垂直发射轨"}</span>
          <i style={{ left: `${Math.max(4, Math.min(92, entity.progress * 92))}%` }}>{railEjector ? <Satellite size={10} /> : <Rocket size={10} />}</i>
          <b />
        </div>
      ) : null}
      {!rayPowerMode && !constructionCenter && !blackHoleConnector && !timeWarpDevice ? <div className="node-io">
        <div className="node-io__column">
          <span className="node-io__label">输入</span>
          {inputs.length > 0 ? inputs.map((input) => (
            <InputSlot
              key={input.itemId}
              entityId={entity.id}
              itemId={input.itemId}
              amount={entity.inputs[input.itemId] ?? 0}
              cargo={cargo}
              onDropCargo={data.onDropCargo}
              onPickInput={data.onPickInput}
              onDropDraggedItem={data.onDropDraggedItem}
              connectionDraft={data.connectionDraft}
              connectionCount={data.inputBeltCounts[input.itemId] ?? 0}
              missing={(data.status.code === "missing-input" || data.status.code === "missing-proliferator") && (entity.inputs[input.itemId] ?? 0) < input.amount}
            />
          )) : rayReceiver ? (
            <div className="stellar-input"><Sun size={14} /><span>戴森系统能量</span></div>
          ) : null}
          {!rayReceiver && !galacticExporter && data.connectionDraft ? <AutoInputPort connectionDraft={data.connectionDraft} label="自动选择配方" /> : null}
        </div>
        <div className="node-io__column node-io__column--output">
          <span className="node-io__label">{galacticExporter ? "去向" : recipe?.id === "matrix_research" ? "科研" : "输出"}</span>
          {galacticExporter ? (
            <div className="galactic-exporter-target"><Rocket size={14} /><span>银河物资出口</span></div>
          ) : recipe?.id === "matrix_research" ? (
            <div className="research-target">
              <FlaskConical size={14} />
              <span>{data.researchLabel ?? "未选择科技"}</span>
            </div>
          ) : recipe && recipe.outputs.length > 0 ? recipe.outputs.map((output) => (
            <OutputSlot
              key={output.itemId}
              entityId={entity.id}
              itemId={output.itemId}
              amount={entity.outputs[output.itemId] ?? 0}
              onPick={data.onPickOutput}
              connectionDraft={data.connectionDraft}
              connectionCount={data.outputBeltCounts[output.itemId] ?? 0}
            />
          )) : railEjector ? (
            <div className="orbital-target"><Orbit size={14} /><span title={data.targetDysonOrbitLabel}>{data.targetDysonOrbitLabel ?? `在轨 ${formatQuantityCompact(data.dysonSwarm.sailsInOrbit)} 帆`}</span></div>
          ) : launchSilo ? (
            <div className="orbital-target"><Rocket size={14} /><span>结构 {formatQuantityCompact(data.dysonSphere.structurePoints)} 点</span></div>
          ) : null}
        </div>
      </div> : null}
      {entity.sprayCoaterInstalled && proliferator ? (
        <div className={`proliferator-readout proliferator-readout--${entity.proliferatorMode ?? "normal"}`}>
          <Sparkles size={13} />
          <span>{entity.proliferatorMode === "extra" ? "额外产出" : entity.proliferatorMode === "speed" ? "生产加速" : "喷涂待机"} · Mk.{proliferator.tier === 3 ? "III" : proliferator.tier === 2 ? "II" : "I"}</span>
          <strong>{proliferatorPoints} 点</strong>
        </div>
      ) : null}
      <footer className="factory-node__footer">
        <span><Zap size={11} /> {blackHoleConnector ? "无需供电" : <><PowerValue valueKw={timeWarpDevice ? entity.powerInputKw ?? 0 : rayReceiver ? entity.powerOutputKw ?? 0 : (building.powerDemandKw ?? 0) * entity.machineCount * getEntityProliferatorPowerMultiplier(entity) * data.powerDemandMultiplier} />{rayReceiver ? " 接收" : null}</>}</span>
        <span><Gauge size={11} /> {railEjector ? `累计 ${formatQuantityCompact(data.dysonSwarm.totalLaunched)} 帆` : launchSilo ? `累计 ${formatQuantityCompact(data.dysonSphere.totalRocketsLaunched)} 枚` : `${(building.speed * speedMultiplier * getEntityProliferatorSpeedMultiplier(entity)).toFixed(2)}×`}</span>
      </footer>
    </article>
  );
}

function LogisticsFullNode({ data, selected }: NodeProps<FactoryFlowNode>) {
  const { entity, cargo, placement } = data;
  const building = getBuilding(entity.buildingId!);
  const itemId = entity.storedItemId;
  const isStation = entity.kind === "station";
  const orbitalCollector = entity.buildingId === "orbital_collector";
  const deliveryHub = entity.buildingId === "material_delivery_hub";
  const elevatorStation = isElevatorStation(entity);
  const deliverySlots = deliveryHub ? getMaterialDeliverySlots(entity) : [];
  const warehouseStorage = entity.buildingId === "storage_mk1" || entity.buildingId === "storage_tank";
  const configuredItems = elevatorStation
    ? []
    : deliveryHub
    ? getMaterialDeliveryItems(entity)
    : isStation && !orbitalCollector
    ? getStationSlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : [])
    : itemId ? [itemId] : [];
  const nodeRef = useDynamicHandles(entity.id, deliveryHub
    ? deliverySlots.map((slot) => `${slot.mode}:${slot.itemId ?? "empty"}`).join(":")
    : `${configuredItems.join(":") || "unconfigured"}:${elevatorStation ? (entity.elevatorOutputItems ?? []).join(":") : "auto"}`);
  const cargoKind = cargo ? getItem(cargo.itemId).kind : null;
  const acceptsCargo = Boolean(cargo && (configuredItems.length === 0 || configuredItems.includes(cargo.itemId) || (deliveryHub && configuredItems.length < MATERIAL_DELIVERY_SLOT_COUNT)) && (
    building.accepts === "any" || building.accepts === cargoKind || (building.accepts === "solid" && cargoKind === "matrix")
  ));
  const adding = placement === entity.buildingId;
  const isSplitter = entity.kind === "splitter";
  const planetaryStation = entity.buildingId === "planetary_logistics_station";
  const stationVehicleCapacity = planetaryStation ? getStationDroneCapacity(entity) : getStationVesselCapacity(entity);
  const stationVehicles = planetaryStation
    ? Math.min(stationVehicleCapacity, Math.max(0, Math.floor(entity.stationDrones ?? 0)))
    : Math.min(stationVehicleCapacity, Math.max(0, Math.floor(entity.stationVessels ?? 0)));
  const primaryStationSlot = isStation && !orbitalCollector ? getStationSlots(entity).find((slot) => slot.itemId) : undefined;
  const primaryStationMode = primaryStationSlot
    ? planetaryStation ? primaryStationSlot.localMode : primaryStationSlot.remoteMode
    : entity.stationMode ?? "storage";

  return (
    <article
      ref={nodeRef}
      className={`factory-node logistics-node factory-node--status-${data.status.tone}${entity.interactionLocked ? " factory-node--locked" : ""}${isStation ? " station-node" : ""}${deliveryHub ? " delivery-hub-node" : ""}${warehouseStorage ? " storage-buffer-node" : ""}${entity.buildingId === "storage_tank" ? " storage-buffer-node--fluid" : ""}${selected ? " factory-node--selected" : ""}${adding ? " factory-node--placement" : ""}${acceptsCargo ? " factory-node--accepts-cargo" : ""}`}
      onClick={(event) => {
        if (!adding) return;
        event.preventDefault();
        event.stopPropagation();
        data.onAddBuilding(entity.id, entity.buildingId!, data.placementCount);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.some((type) => type === "application/factory-item" || type === "application/factory-building")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const buildingId = event.dataTransfer.getData("application/factory-building") as BuildingId;
        if (buildingId === entity.buildingId) {
          data.onAddBuilding(entity.id, buildingId, data.placementCount);
          return;
        }
        const draggedItem = event.dataTransfer.getData("application/factory-item") as ItemId;
        if (!draggedItem) return;
        const sourceKind = event.dataTransfer.getData("application/factory-source-kind") as DraggedItemSourceKind;
        const sourceId = event.dataTransfer.getData("application/factory-source-id") || undefined;
        data.onDropDraggedItem(entity.id, draggedItem, sourceKind, sourceId);
      }}
    >
      <InteractionLockBadge entity={entity} onChange={data.onInteractionLockChange} />
      <header className="factory-node__header">
        <div className="node-icon">{isStation ? <Orbit size={18} /> : isSplitter ? <GitFork size={18} /> : <Database size={18} />}</div>
        <div><span>{deliveryHub ? "物资托盘直送" : orbitalCollector ? "气态巨星采集" : planetaryStation ? "行星无线运输" : isStation ? "跨行星运输" : isSplitter ? "物流分配" : "物流缓存"}</span><strong>{building.name}</strong></div>
        <small>×{entity.machineCount}</small>
      </header>
      <WorkCycle
        label={deliveryHub ? "直送周期" : orbitalCollector ? "采集周期" : planetaryStation ? "运输机航程" : isStation ? "运输船航程" : "物流周期"}
        progress={orbitalCollector ? entity.progress : isStation ? entity.stationProgress ?? 0 : 0}
        active={!data.paused && (isStation ? entity.utilization > 0.001 : data.activeLogisticsEntityIds.includes(entity.id))}
        efficiency={isStation ? entity.utilization : data.activeLogisticsEntityIds.includes(entity.id) ? 1 : 0}
        cyclesPerSecond={orbitalCollector ? data.cycleRatePerSecond : 0}
        mode={orbitalCollector ? "cycle" : isStation ? "route" : "indeterminate"}
        semanticKey={`${entity.id}:${isStation ? (entity.stationRoutes ?? []).map((route) => route.id).join(",") || "idle" : configuredItems.join(",") || "empty"}`}
        effectiveSimulationMultiplier={data.simulationMultiplier}
      />
      {elevatorStation ? (
        <div className="node-io logistics-io elevator-logistics-io">
          <div className="logistics-slot-row"><div className="node-io__column"><span className="node-io__label">通用输入</span><AutoInputPort connectionDraft={data.connectionDraft} label="任意物资" handleId="in:auto" /></div><div className="delivery-hub-target"><Database size={14} /><span>进入系统共享仓库</span></div></div>
          {(entity.elevatorOutputItems ?? []).map((outputItemId, index) => outputItemId ? <div className="logistics-slot-row" key={`${outputItemId}:${index}`}><div className="node-io__column node-io__column--output"><span className="node-io__label">输出 {index + 1}</span><OutputSlot entityId={entity.id} itemId={outputItemId} amount={entity.outputs[outputItemId] ?? 0} onPick={data.onPickOutput} connectionDraft={data.connectionDraft} connectionCount={data.outputBeltCounts[outputItemId] ?? 0} /></div><div className="delivery-hub-target"><Route size={14} /><span>{ITEMS[outputItemId].name}</span></div></div> : <div className="logistics-slot-row" key={`empty-output:${index}`}><div className="node-io__column node-io__column--output"><span className="node-io__label">输出 {index + 1}</span><span className="logistics-empty">未配置</span></div></div>)}
        </div>
      ) : deliveryHub ? (
        <div className="node-io logistics-io delivery-hub-io">
          {deliverySlots.map((slot, index) => <div className={`logistics-slot-row delivery-hub-slot-row delivery-hub-slot-row--${slot.mode}`} key={`delivery-${index}`}>
            <div className="node-io__column">
              <span className="node-io__label">接口 {index + 1}</span>
              {slot.itemId ? <InputSlot entityId={entity.id} itemId={slot.itemId} amount={entity.inputs[slot.itemId] ?? 0} cargo={cargo} onDropCargo={data.onDropCargo} onPickInput={data.onPickInput} onDropDraggedItem={data.onDropDraggedItem} connectionDraft={data.connectionDraft} connectionCount={data.inputBeltCounts[slot.itemId] ?? 0} handleId={`in:delivery:${index}`} />
                : slot.mode === "disabled" ? <div className="delivery-hub-port-disabled">接口已清空</div>
                  : <AutoInputPort connectionDraft={data.connectionDraft} label="自动识别" handleId={`in:delivery:${index}`} />}
            </div>
            <div className="delivery-hub-target" title={slot.mode === "manual" ? "指定物资直接送入当前行星物资托盘" : slot.mode === "disabled" ? "此接口已停止接收" : "自动识别后送入当前行星物资托盘"}><Database size={14} /><span>{slot.mode === "manual" ? "指定直送" : slot.mode === "disabled" ? "停止接收" : "进入托盘"}</span></div>
          </div>)}
        </div>
      ) : configuredItems.length > 0 ? (
        <div className={`node-io logistics-io${orbitalCollector ? " logistics-io--collector" : ""}`}>
          {configuredItems.map((configuredItemId, index) => <div className={`logistics-slot-row${warehouseStorage ? " logistics-slot-row--warehouse" : ""}`} key={configuredItemId}>
            {!orbitalCollector ? <div className="node-io__column">
              {index === 0 ? <span className="node-io__label">输入</span> : null}
              <InputSlot entityId={entity.id} itemId={configuredItemId} amount={entity.inputs[configuredItemId] ?? 0} cargo={cargo} onDropCargo={data.onDropCargo} onPickInput={data.onPickInput} onDropDraggedItem={data.onDropDraggedItem} connectionDraft={data.connectionDraft} connectionCount={data.inputBeltCounts[configuredItemId] ?? 0} />
            </div> : null}
            {!deliveryHub ? <div className="node-io__column node-io__column--output">
              {index === 0 ? <span className="node-io__label">输出</span> : null}
              <OutputSlot entityId={entity.id} itemId={configuredItemId} amount={entity.outputs[configuredItemId] ?? 0} onPick={data.onPickOutput} connectionDraft={data.connectionDraft} connectionCount={data.outputBeltCounts[configuredItemId] ?? 0} />
            </div> : <div className="delivery-hub-target"><Database size={14} /><span>进入物资托盘</span></div>}
          </div>)}
        </div>
      ) : (
        <div className="logistics-empty">{deliveryHub ? "连接任意输出端口，自动占用 3 个直送接口" : planetaryStation ? "在检查器中选择行星货物" : isStation ? "在检查器中选择星际货物" : "拖入物品或在检查器中选择缓存类型"}</div>
      )}
      {!orbitalCollector && !deliveryHub && data.connectionDraft ? <div className="logistics-auto-input"><AutoInputPort connectionDraft={data.connectionDraft} label={isStation ? "连接时自动占用空槽" : "连接时自动设置物品"} /></div> : null}
      <footer className="factory-node__footer">
        <span title={data.status.label}>{data.status.label}</span>
        <span title={isStation ? `累计 ${entity.stationTrips ?? 0} 航次` : undefined}>{deliveryHub ? `${configuredItems.length}/${MATERIAL_DELIVERY_SLOT_COUNT} 接口 · ${entity.productionRate.toFixed(1)}/min` : orbitalCollector ? `${itemId ? ITEMS[itemId].name : "资源"} · ${entity.productionRate.toFixed(1)}/min` : isStation ? `${primaryStationMode === "demand" ? "需求" : primaryStationMode === "supply" ? "供应" : "仓储"} · ${configuredItems.length}/5 槽 · ${stationVehicles}/${stationVehicleCapacity} ${planetaryStation ? "机队" : "舰队"}` : isSplitter ? entity.distributionMode === "priority" ? "优先分流" : "均衡分流" : `${data.outputCapacity} 容量`}</span>
      </footer>
    </article>
  );
}

function PowerFullNode({ data, selected }: NodeProps<FactoryFlowNode>) {
  const { entity, placement, cargo } = data;
  const building = getBuilding(entity.buildingId!);
  const recipe = getRecipe(entity.recipeId);
  const fuelOptions = getFuelItemIdsForBuilding(entity.buildingId!);
  const fuelGenerator = fuelOptions.length > 0;
  const accumulator = entity.buildingId === "accumulator";
  const exchanger = entity.buildingId === "energy_exchanger";
  const solar = entity.buildingId === "solar_panel";
  const geothermal = entity.buildingId === "geothermal_power_station";
  useDynamicHandles(entity.id, `${entity.fuelItemId ?? "no-fuel-port"}:${recipe?.id ?? "no-energy-recipe"}`);
  const adding = placement === entity.buildingId;
  const fuelId = entity.fuelItemId;
  const environmentMultiplier = solar ? data.solarGenerationMultiplier : geothermal ? data.geothermalGenerationMultiplier : data.windGenerationMultiplier;
  const ratedPower = (building.powerGenerationKw ?? 0) * entity.machineCount * environmentMultiplier;
  const energyCapacity = (building.energyCapacityMj ?? 0) * entity.machineCount;
  const energyPercent = energyCapacity > 0 ? (entity.storedEnergyMj ?? 0) / energyCapacity : 0;
  const acceptsItems = fuelGenerator || exchanger;
  const icon = accumulator ? <BatteryFull size={19} /> : exchanger ? <BatteryCharging size={19} /> :
    solar ? <Sun size={19} /> : geothermal ? <ThermometerSun size={19} /> : fuelGenerator ? <Flame size={19} /> : <Wind size={19} />;
  const category = accumulator ? "电网缓冲储能" : exchanger ? "可运输储能" : fuelGenerator ? "可调度能源" : solar ? "恒星辐射发电" : geothermal ? "熔岩地热发电" : "行星电网";
  return (
    <article
      className={`factory-node power-node factory-node--status-${data.status.tone}${entity.interactionLocked ? " factory-node--locked" : ""}${fuelGenerator ? " thermal-node" : ""}${accumulator || exchanger ? " storage-power-node" : ""}${selected ? " factory-node--selected" : ""}${adding ? " factory-node--placement" : ""}`}
      onClick={(event) => {
        if (!adding) return;
        event.preventDefault();
        event.stopPropagation();
        data.onAddBuilding(entity.id, entity.buildingId!, data.placementCount);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/factory-building") ||
          (acceptsItems && event.dataTransfer.types.includes("application/factory-item"))) event.preventDefault();
      }}
      onDrop={(event) => {
        const buildingId = event.dataTransfer.getData("application/factory-building") as BuildingId;
        if (buildingId === entity.buildingId) {
          event.preventDefault();
          event.stopPropagation();
          data.onAddBuilding(entity.id, buildingId, data.placementCount);
          return;
        }
        if (!acceptsItems) return;
        const draggedItem = event.dataTransfer.getData("application/factory-item") as ItemId;
        if (!draggedItem) return;
        event.preventDefault();
        event.stopPropagation();
        const sourceKind = event.dataTransfer.getData("application/factory-source-kind") as DraggedItemSourceKind;
        const sourceId = event.dataTransfer.getData("application/factory-source-id") || undefined;
        data.onDropDraggedItem(entity.id, draggedItem, sourceKind, sourceId);
      }}
    >
      <InteractionLockBadge entity={entity} onChange={data.onInteractionLockChange} />
      <header className="factory-node__header">
        <div className="node-icon node-icon--power">{icon}</div>
        <div>
          <span>{category}</span>
          <strong>{building.name}</strong>
        </div>
        <small>×{entity.machineCount}</small>
      </header>
      {fuelGenerator && selected && !entity.interactionLocked ? (
        <label className="node-inline-select nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
          <span>燃烧燃料</span>
          <select value={fuelId ?? ""} onChange={(event) => data.onFuelChange(entity.id, event.target.value as ItemId)}>
            <option value="" disabled>选择燃料</option>
            {fuelOptions.map((itemId) => <option value={itemId} key={itemId}>{ITEMS[itemId].name} · {FUEL_ENERGY_MJ[itemId]} MJ</option>)}
          </select>
        </label>
      ) : null}
      {exchanger && selected && !entity.interactionLocked ? (
        <label className="node-inline-select nodrag nopan" onPointerDown={(event) => event.stopPropagation()}>
          <span>能量模式</span>
          <select value={entity.energyMode === "discharge" ? "discharge" : "charge"} disabled={(entity.storedEnergyMj ?? 0) > 0.0001} onChange={(event) => data.onEnergyModeChange(entity.id, event.target.value as EnergyMode)}>
            <option value="charge">充电 · 空 → 满</option>
            <option value="discharge">放电 · 满 → 空</option>
          </select>
        </label>
      ) : null}
      {accumulator || exchanger ? (
        <WorkCycle
          label={accumulator ? "储能电量" : entity.energyMode === "discharge" ? "放电周期" : "充电周期"}
          progress={accumulator ? energyPercent : entity.progress}
          active={!data.paused && ((entity.powerInputKw ?? 0) > 0.001 || (entity.powerOutputKw ?? 0) > 0.001)}
          efficiency={entity.utilization}
          cyclesPerSecond={accumulator ? 0 : data.cycleRatePerSecond}
          mode={accumulator ? "level" : "cycle"}
          semanticKey={`${entity.id}:${accumulator ? "stored-energy" : entity.energyMode ?? "charge"}`}
          effectiveSimulationMultiplier={data.simulationMultiplier}
        />
      ) : null}
      <div className="power-output">
        {accumulator || exchanger ? <BatteryCharging size={17} /> : fuelGenerator ? <Flame size={17} /> : <Zap size={17} />}
        <span>{fuelGenerator || accumulator || exchanger ? data.status.label : "额定发电"}</span>
        <strong>{(entity.powerInputKw ?? 0) > 0.001
          ? <PowerValue valueKw={-(entity.powerInputKw ?? 0)} />
          : fuelGenerator || accumulator || exchanger
            ? <><PowerValue valueKw={entity.powerOutputKw ?? 0} /> / <PowerValue valueKw={ratedPower} /></>
            : <PowerValue valueKw={ratedPower} />}</strong>
      </div>
      {fuelGenerator && fuelId ? (
        <div className="thermal-fuel">
          <InputSlot entityId={entity.id} itemId={fuelId} amount={entity.inputs[fuelId] ?? 0} cargo={cargo} onDropCargo={data.onDropCargo} onPickInput={data.onPickInput} onDropDraggedItem={data.onDropDraggedItem} connectionDraft={data.connectionDraft} connectionCount={data.inputBeltCounts[fuelId] ?? 0} missing={data.status.code === "missing-fuel"} />
          <span>炉膛余热 <strong>{(entity.fuelRemainingMj ?? 0).toFixed(2)} MJ</strong></span>
        </div>
      ) : fuelGenerator ? <div className="thermal-empty">未配置燃料</div> : null}
      {exchanger && recipe ? (
        <div className="node-io energy-exchange-io">
          <div className="node-io__column">
            <span className="node-io__label">输入</span>
            {recipe.inputs.map((input) => <InputSlot key={input.itemId} entityId={entity.id} itemId={input.itemId} amount={entity.inputs[input.itemId] ?? 0} cargo={cargo} onDropCargo={data.onDropCargo} onPickInput={data.onPickInput} onDropDraggedItem={data.onDropDraggedItem} connectionDraft={data.connectionDraft} connectionCount={data.inputBeltCounts[input.itemId] ?? 0} missing={data.status.code === "missing-input" && (entity.inputs[input.itemId] ?? 0) < input.amount} />)}
          </div>
          <div className="node-io__column node-io__column--output">
            <span className="node-io__label">输出</span>
            {recipe.outputs.map((output) => <OutputSlot key={output.itemId} entityId={entity.id} itemId={output.itemId} amount={entity.outputs[output.itemId] ?? 0} onPick={data.onPickOutput} connectionDraft={data.connectionDraft} connectionCount={data.outputBeltCounts[output.itemId] ?? 0} />)}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function VeinNode(props: NodeProps<FactoryFlowNode>) {
  return props.data.lod === "full" ? <VeinFullNode {...props} /> : <FactoryNodeLodView {...props} />;
}

export function MachineNode(props: NodeProps<FactoryFlowNode>) {
  return props.data.lod === "full" ? <MachineFullNode {...props} /> : <FactoryNodeLodView {...props} />;
}

export function LogisticsNode(props: NodeProps<FactoryFlowNode>) {
  return props.data.lod === "full" ? <LogisticsFullNode {...props} /> : <FactoryNodeLodView {...props} />;
}

export function PowerNode(props: NodeProps<FactoryFlowNode>) {
  return props.data.lod === "full" ? <PowerFullNode {...props} /> : <FactoryNodeLodView {...props} />;
}

function areNodeVisualPropsEqual(previous: NodeProps<FactoryFlowNode>, next: NodeProps<FactoryFlowNode>): boolean {
  return previous.id === next.id &&
    previous.selected === next.selected &&
    previous.data.visualSignature === next.data.visualSignature &&
    previous.data.presentationSignature === next.data.presentationSignature &&
    previous.data.entity.position.x === next.data.entity.position.x &&
    previous.data.entity.position.y === next.data.entity.position.y;
}

const MemoVeinNode = memo(VeinNode, areNodeVisualPropsEqual);
const MemoMachineNode = memo(MachineNode, areNodeVisualPropsEqual);
const MemoLogisticsNode = memo(LogisticsNode, areNodeVisualPropsEqual);
const MemoPowerNode = memo(PowerNode, areNodeVisualPropsEqual);

export const NODE_TYPES = {
  vein: MemoVeinNode,
  machine: MemoMachineNode,
  power: MemoPowerNode,
  storage: MemoLogisticsNode,
  splitter: MemoLogisticsNode,
  station: MemoLogisticsNode,
};
