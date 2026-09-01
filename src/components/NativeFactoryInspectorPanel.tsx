import { Atom, CircuitBoard, Database, Factory, Flame, Gauge, Layers3, LockKeyhole, Minus, Orbit, Pause, Play, Plus, RotateCcw, Route, Satellite, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CONSTRUCTION, FUEL_ENERGY_MJ, ITEMS } from "../game/content";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  ItemQuantityReadModel,
  NativeStationRoutePolicyReadModel,
  SelectedBeltReadModel,
  SelectedEntityReadModel,
} from "../game/factoryReadModels";
import {
  canNativeProjectedEnergyExchangerModeChange,
  getNativeProjectedEnergyExchangerMode,
  getNativeProjectedFuelItemConfiguration,
  getNativeProjectedPowerPriority,
  getNativeProjectedSplitterDistributionMode,
  type NativeProjectedEnergyExchangerMode,
  type NativeProjectedEntityConfigurationBinding,
  type NativeProjectedSplitterDistributionMode,
} from "../game/nativeProjectedEntityConfigurationCommands";
import {
  getNativeProjectedMaterialDeliveryConfiguration,
  getNativeProjectedOrbitalCargoConfiguration,
} from "../game/nativeProjectedSpecialInputPortCommands";
import {
  getNativeProjectedEntityRecipeConfiguration,
  isNativeProjectedOrdinaryRecipeBuilding,
  type NativeProjectedEntityRecipeBinding,
} from "../game/nativeProjectedEntityRecipeCommands";
import {
  getNativeProjectedTimeWarpControllerState,
  type NativeProjectedEjectorOrbitFrame,
  type NativeProjectedTimeWarpControllerBinding,
} from "../game/nativeProjectedTimeWarpEjectorCommands";
import type {
  NativeProjectedStationConfigurationBinding,
  NativeProjectedStationInventoryAdjustment,
} from "../game/nativeProjectedStationConfigurationCommands";
import type { NativeStationFleetKind } from "../game/nativeStationInventoryIntentCommands";
import type { NativeStationSlotMode, NativeStationSlotScope } from "../game/nativeStationSlotIntentCommands";
import type { ItemId, LogisticsPriority, MaterialDeliverySlotMode, PowerPriority, RecipeId, StationMinimumLoad } from "../game/types";
import { AccessibleDialog } from "./AccessibleDialog";
import { PowerValue } from "./PowerValue";
import { QuantityValue } from "./QuantityValue";

interface NativeFactoryInspectorPanelProps {
  inspector: FactoryInspectorSummaryReadModel;
  multiSelection: FactoryMultiSelectionSummaryReadModel;
  entityConfiguration: NativeProjectedEntityConfigurationBinding | null;
  entityRecipeBinding?: NativeProjectedEntityRecipeBinding | null;
  timeWarpController?: NativeProjectedTimeWarpControllerBinding | null;
  ejectorOrbitFrame?: NativeProjectedEjectorOrbitFrame | null;
  stationConfiguration?: NativeProjectedStationConfigurationBinding | null;
  pending: boolean;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveEntity: (entityId: string) => void;
  onStackCountChange: (entityId: string, targetCount: number) => void;
  onEntityPowerPriorityChange: (entityId: string, targetPriority: PowerPriority) => void;
  onSplitterDistributionModeChange: (
    entityId: string,
    targetMode: NativeProjectedSplitterDistributionMode,
  ) => void;
  onEnergyExchangerModeChange: (
    entityId: string,
    targetMode: NativeProjectedEnergyExchangerMode,
  ) => void;
  onFuelItemChange: (entityId: string, targetItemId: ItemId) => void;
  onEntityRecipeChange?: (entityId: string, targetRecipeId: RecipeId) => void;
  onBlackHolePausedChange: (
    entityId: string,
    paused: boolean,
  ) => void;
  onGalacticExporterPausedChange?: (entityId: string, paused: boolean) => void;
  onMaterialDeliverySlotChange?: (
    entityId: string,
    slotIndex: number,
    mode: MaterialDeliverySlotMode,
    itemId: ItemId | null,
  ) => void;
  onOrbitalCargoPortClear?: (entityId: string, portIndex: number) => void;
  onTimeWarpEnabledChange?: (entityId: string, enabled: boolean) => void;
  onTimeWarpRequestedMultiplierChange?: (entityId: string, requestedMultiplier: number) => void;
  onEjectorOrbitChange?: (entityId: string, orbitId: string) => void;
  onStationConfigurationChange?: (
    entityId: string,
    action: NativeStationConfigurationUiAction,
  ) => void;
  onBeltLaneCountChange: (beltId: string, targetLanes: number) => void;
  onBeltPriorityChange: (beltId: string, targetPriority: 0 | 1 | 2) => void;
  onRemoveBelt: (beltId: string) => void;
}

export type NativeStationConfigurationUiAction =
  | Readonly<{
      kind: "slot-mode";
      slotIndex: number;
      scope: NativeStationSlotScope;
      target: NativeStationSlotMode;
    }>
  | Readonly<{ kind: "slot-item"; slotIndex: number; target: string | null }>
  | Readonly<{ kind: "slot-priority"; slotIndex: number; target: LogisticsPriority }>
  | Readonly<{ kind: "slot-minimum-load"; slotIndex: number; target: StationMinimumLoad }>
  | Readonly<{ kind: "slot-limits"; slotIndex: number; minStock: number; maxStock: number }>
  | Readonly<{ kind: "slot-route-policy"; slotIndex: number; target: NativeStationRoutePolicyReadModel }>
  | Readonly<{ kind: "slot-warper-budget"; slotIndex: number; target: number }>
  | Readonly<{
      kind: "station-fleet-adjust";
      fleetKind: NativeStationFleetKind;
      adjustment: NativeProjectedStationInventoryAdjustment;
    }>
  | Readonly<{
      kind: "station-warper-inventory-adjust";
      adjustment: NativeProjectedStationInventoryAdjustment;
    }>
  | Readonly<{
      kind: "station-scalar";
      field: "stationWarpEnabled" | "stationWarperAutoRefill" | "stationHubEnabled";
      target: boolean;
    }>
  | Readonly<{ kind: "station-scalar"; field: "stationWarperTarget"; target: number }>
  | Readonly<{ kind: "station-scalar"; field: "stationHubPriority"; target: LogisticsPriority }>;

const constructionNames = new Map<string, string>(
  CONSTRUCTION.map((definition) => [definition.buildingId, definition.name]),
);
const itemNames = new Map<string, string>(
  Object.entries(ITEMS).map(([itemId, item]) => [itemId, item.name]),
);

function itemLabel(itemId: string): string {
  return itemNames.get(itemId) ?? itemId;
}

function itemRows(label: string, rows: readonly ItemQuantityReadModel[], truncated: boolean) {
  return <section className="native-inspector-items">
    <header><span>{label}</span><strong>{rows.length}{truncated ? "+" : ""}</strong></header>
    {rows.length === 0 ? <p>无</p> : rows.map((row) => <div key={row.itemId}>
      <span>{itemLabel(row.itemId)}</span><QuantityValue value={row.amount} interactive={false} />
    </div>)}
    {truncated ? <small>条目超过有界投影上限，剩余内容不会从旧网页存档补读。</small> : null}
  </section>;
}

interface PendingNativeStationSlotItemChange {
  readonly entityId: string;
  readonly planetId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly slotIndex: number;
  readonly previousItemId: string | null;
  readonly targetItemId: string | null;
}

interface PendingNativeEntityRecipeChange {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly activePlanetId: string;
  readonly entityId: string;
  readonly planetId: string;
  readonly currentRecipeId: RecipeId | null;
  readonly targetRecipeId: RecipeId;
}

type PendingNativeSpecialInputPortChange = Readonly<
  | {
      kind: "material-delivery";
      sessionId: string;
      runId: string;
      revision: number;
      entityId: string;
      slotIndex: number;
      mode: MaterialDeliverySlotMode;
      itemId: ItemId | null;
    }
  | {
      kind: "orbital-cargo-clear";
      sessionId: string;
      runId: string;
      revision: number;
      entityId: string;
      portIndex: number;
      itemId: ItemId;
    }
>;

function NativeStationConfiguration({
  entity,
  binding,
  pending,
  onChange,
}: {
  entity: SelectedEntityReadModel;
  binding: NativeProjectedStationConfigurationBinding | null;
  pending: boolean;
  onChange?: (entityId: string, action: NativeStationConfigurationUiAction) => void;
}) {
  const configuration = entity.stationConfiguration;
  const [pendingSlotItemChange, setPendingSlotItemChange] = useState<PendingNativeStationSlotItemChange | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmationSubmittingRef = useRef(false);
  useEffect(() => {
    setPendingSlotItemChange(null);
    confirmationSubmittingRef.current = false;
  }, [
    binding?.activePlanetId,
    binding?.revision,
    binding?.runId,
    binding?.sessionId,
    entity.entityId,
    entity.interactionLocked,
    entity.planetId,
    pending,
  ]);
  if (!configuration) return null;
  const writable = Boolean(binding && onChange && !pending && !entity.interactionLocked);
  const submit = (action: NativeStationConfigurationUiAction) => {
    if (writable) onChange?.(entity.entityId, action);
  };
  const interstellar = configuration.stationType === "interstellar";
  const optionById = new Map(configuration.itemOptions.rows.map((option) => [option.itemId, option]));
  const configuredItemIds = new Set(configuration.slots.flatMap((slot) => slot.itemId ? [slot.itemId] : []));
  const modeLabel = (mode: NativeStationSlotMode) => ({ supply: "供应", demand: "需求", storage: "仓储" })[mode];
  const confirmationIsCurrent = Boolean(binding && pendingSlotItemChange &&
    pendingSlotItemChange.entityId === entity.entityId &&
    pendingSlotItemChange.planetId === entity.planetId &&
    pendingSlotItemChange.sessionId === binding.sessionId &&
    pendingSlotItemChange.runId === binding.runId &&
    pendingSlotItemChange.revision === binding.revision &&
    binding.activePlanetId === entity.planetId &&
    configuration.slots[pendingSlotItemChange.slotIndex]?.itemId === pendingSlotItemChange.previousItemId);
  const confirmSlotItemChange = () => {
    if (!confirmationIsCurrent || !pendingSlotItemChange || !writable || confirmationSubmittingRef.current) {
      setPendingSlotItemChange(null);
      return;
    }
    confirmationSubmittingRef.current = true;
    const action: NativeStationConfigurationUiAction = {
      kind: "slot-item",
      slotIndex: pendingSlotItemChange.slotIndex,
      target: pendingSlotItemChange.targetItemId,
    };
    setPendingSlotItemChange(null);
    try {
      onChange?.(entity.entityId, action);
    } finally {
      // App may reject synchronously without entering the pending state. The
      // closed dialog already prevents a double click, so release the local
      // submission guard and allow an explicit retry from the same projection.
      confirmationSubmittingRef.current = false;
    }
  };
  const adjustmentLabel = (adjustment: NativeProjectedStationInventoryAdjustment) => {
    if (adjustment === "zero") return "归零";
    if (adjustment === "capacity") return "填满";
    return adjustment > 0 ? `+${adjustment}` : String(adjustment);
  };
  const adjustments = [-10, -1, "zero", 1, 10, "capacity"] as const;
  const fleetControl = (
    label: string,
    fleetKind: NativeStationFleetKind,
    current: number,
    capacity: number,
  ) => <div className="native-station-inventory-control">
    <strong>{label} {current} / {capacity}</strong>
    <div className="native-inspector-stack-actions" role="group" aria-label={`Windows 原生${label}数量`}>
      {adjustments.map((adjustment) => {
        const decreasing = adjustment === "zero" || typeof adjustment === "number" && adjustment < 0;
        const increasing = adjustment === "capacity" || typeof adjustment === "number" && adjustment > 0;
        return <button
          type="button"
          key={adjustment}
          disabled={!writable || decreasing && current === 0 || increasing && current >= capacity}
          aria-label={`${label}${adjustmentLabel(adjustment)}`}
          onClick={() => submit({ kind: "station-fleet-adjust", fleetKind, adjustment })}
        >{adjustmentLabel(adjustment)}</button>;
      })}
    </div>
  </div>;
  const droneCapacity = entity.machineCount * 50;
  const vesselCapacity = entity.machineCount * 10;
  const warperCapacity = entity.machineCount * 50;
  const stationWarpers = configuration.stationWarpers;
  return <><section
    className="native-inspector-safe-actions native-station-configuration"
    data-native-station-configuration="bounded-slot-intents-v1"
  >
    <strong>Rust 物流站配置</strong>
    <p>槽位、舰队和站内翘曲器都只提交一个语义意图，由 Rust 在最新 revision 重算路线、退款和库存；界面等待 durable ACK 后再刷新。</p>
    <dl className="metric-ledger">
      <div><dt>无人机</dt><dd>{configuration.stationDrones}</dd></div>
      <div><dt>运输船</dt><dd>{configuration.stationVessels ?? "-"}</dd></div>
      <div><dt>站内翘曲器</dt><dd>{configuration.stationWarpers ?? "-"}</dd></div>
    </dl>
    {fleetControl("物流无人机", "drone", configuration.stationDrones, droneCapacity)}
    {interstellar && configuration.stationVessels !== null
      ? fleetControl("物流运输船", "vessel", configuration.stationVessels, vesselCapacity)
      : null}
    {interstellar && stationWarpers !== null ? <div className="native-station-inventory-control">
      <strong>站内翘曲器 {stationWarpers} / {warperCapacity}</strong>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生站内翘曲器数量">
        {adjustments.map((adjustment) => {
          const decreasing = adjustment === "zero" || typeof adjustment === "number" && adjustment < 0;
          const increasing = adjustment === "capacity" || typeof adjustment === "number" && adjustment > 0;
          return <button
            type="button"
            key={adjustment}
            disabled={!writable || !configuration.spaceWarpUnlocked || decreasing && stationWarpers === 0 || increasing && stationWarpers >= warperCapacity}
            aria-label={`站内翘曲器${adjustmentLabel(adjustment)}`}
            onClick={() => submit({ kind: "station-warper-inventory-adjust", adjustment })}
          >{adjustmentLabel(adjustment)}</button>;
        })}
      </div>
    </div> : null}
    {interstellar ? <>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生星际站开关">
        <button
          type="button"
          disabled={!writable || !configuration.stationWarpEnabled && !configuration.spaceWarpUnlocked}
          aria-pressed={configuration.stationWarpEnabled ?? false}
          onClick={() => submit({ kind: "station-scalar", field: "stationWarpEnabled", target: !configuration.stationWarpEnabled })}
        >{configuration.stationWarpEnabled ? "关闭翘曲" : "启用翘曲"}</button>
        <button
          type="button"
          disabled={!writable || !configuration.stationWarperAutoRefill && !configuration.spaceWarpUnlocked}
          aria-pressed={configuration.stationWarperAutoRefill ?? false}
          onClick={() => submit({ kind: "station-scalar", field: "stationWarperAutoRefill", target: !configuration.stationWarperAutoRefill })}
        >{configuration.stationWarperAutoRefill ? "关闭自动补充" : "启用自动补充"}</button>
        <button
          type="button"
          disabled={!writable}
          aria-pressed={configuration.stationHubEnabled ?? false}
          onClick={() => submit({ kind: "station-scalar", field: "stationHubEnabled", target: !configuration.stationHubEnabled })}
        >{configuration.stationHubEnabled ? "关闭枢纽" : "启用枢纽"}</button>
      </div>
      <label>
        <span>翘曲器目标</span>
        <input
          key={`warper-target-${configuration.stationWarperTarget}`}
          aria-label="Windows 原生物流站翘曲器目标"
          type="number"
          min={1}
          max={Math.max(1, entity.machineCount * 50)}
          defaultValue={configuration.stationWarperTarget ?? 1}
          disabled={!writable}
          onBlur={(event) => {
            const target = Number(event.currentTarget.value);
            if (Number.isSafeInteger(target)) submit({ kind: "station-scalar", field: "stationWarperTarget", target });
          }}
        />
      </label>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生物流站枢纽优先级">
        {([0, 1, 2] as const).map((priority) => <button
          type="button"
          key={priority}
          disabled={!writable || configuration.stationHubPriority === priority}
          aria-pressed={configuration.stationHubPriority === priority}
          onClick={() => submit({ kind: "station-scalar", field: "stationHubPriority", target: priority })}
        >枢纽 {priority}</button>)}
      </div>
    </> : null}
    {configuration.slots.map((slot) => <fieldset key={slot.slotIndex} className="native-station-slot">
      <legend>槽位 {slot.slotIndex + 1}</legend>
      <label><span>物品</span><select
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 物品`}
        value={slot.itemId ?? ""}
        disabled={!writable}
        onChange={(event) => {
          if (!binding || !writable) return;
          const targetItemId = event.currentTarget.value || null;
          if (targetItemId === slot.itemId) return;
          setPendingSlotItemChange({
            entityId: entity.entityId,
            planetId: entity.planetId,
            sessionId: binding.sessionId,
            runId: binding.runId,
            revision: binding.revision,
            slotIndex: slot.slotIndex,
            previousItemId: slot.itemId,
            targetItemId,
          });
        }}
      >
        <option value="">未配置</option>
        {slot.itemId && !optionById.has(slot.itemId)
          ? <option value={slot.itemId}>{slot.itemId}（当前）</option>
          : null}
        {configuration.itemOptions.rows.map((option) => <option
          value={option.itemId}
          key={option.itemId}
          disabled={option.itemId !== slot.itemId && configuredItemIds.has(option.itemId)}
        >{option.name}</option>)}
      </select></label>
      <label><span>本地模式</span><select
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 本地模式`}
        value={slot.localMode}
        disabled={!writable}
        onChange={(event) => submit({
          kind: "slot-mode",
          slotIndex: slot.slotIndex,
          scope: "local",
          target: event.currentTarget.value as NativeStationSlotMode,
        })}
      >
        {(["supply", "demand", "storage"] as const).map((mode) => <option value={mode} key={mode}>{modeLabel(mode)}</option>)}
      </select></label>
      {interstellar ? <label><span>星际模式</span><select
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 星际模式`}
        value={slot.remoteMode}
        disabled={!writable}
        onChange={(event) => submit({
          kind: "slot-mode",
          slotIndex: slot.slotIndex,
          scope: "remote",
          target: event.currentTarget.value as NativeStationSlotMode,
        })}
      >
        {(["supply", "demand", "storage"] as const).map((mode) => <option value={mode} key={mode}>{modeLabel(mode)}</option>)}
      </select></label> : null}
      <label><span>最低装载</span><select
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 最低装载`}
        value={slot.minimumLoad}
        disabled={!writable}
        onChange={(event) => submit({
          kind: "slot-minimum-load",
          slotIndex: slot.slotIndex,
          target: Number(event.target.value) as StationMinimumLoad,
        })}
      >{([0.1, 0.25, 0.5, 1] as const).map((value) => <option value={value} key={value}>{value * 100}%</option>)}</select></label>
      <label><span>最低库存</span><input
        key={`min-${slot.slotIndex}-${slot.minStock}`}
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 最低库存`}
        type="number" min={0} max={100_000_000} defaultValue={slot.minStock} disabled={!writable}
        onBlur={(event) => submit({ kind: "slot-limits", slotIndex: slot.slotIndex, minStock: Number(event.currentTarget.value), maxStock: slot.maxStock })}
      /></label>
      <label><span>最高库存</span><input
        key={`max-${slot.slotIndex}-${slot.maxStock}`}
        aria-label={`物流站槽位 ${slot.slotIndex + 1} 最高库存`}
        type="number" min={0} max={100_000_000} defaultValue={slot.maxStock} disabled={!writable}
        onBlur={(event) => submit({ kind: "slot-limits", slotIndex: slot.slotIndex, minStock: slot.minStock, maxStock: Number(event.currentTarget.value) })}
      /></label>
      <div className="native-inspector-stack-actions" role="group" aria-label={`物流站槽位 ${slot.slotIndex + 1} 优先级`}>
        {([0, 1, 2] as const).map((priority) => <button type="button" key={priority}
          disabled={!writable || slot.priority === priority} aria-pressed={slot.priority === priority}
          onClick={() => submit({ kind: "slot-priority", slotIndex: slot.slotIndex, target: priority })}
        >{priority}</button>)}
      </div>
      {interstellar && slot.routePolicy && slot.warperBudget ? <>
        <label><span>路线策略</span><select
          aria-label={`物流站槽位 ${slot.slotIndex + 1} 路线策略`}
          value={slot.routePolicy}
          disabled={!writable}
          onChange={(event) => submit({ kind: "slot-route-policy", slotIndex: slot.slotIndex, target: event.target.value as NativeStationRoutePolicyReadModel })}
        >
          <option value="direct">直达</option><option value="relay-preferred">优先中继</option><option value="relay-required">必须中继</option>
        </select></label>
        <label><span>翘曲器预算</span><select
          aria-label={`物流站槽位 ${slot.slotIndex + 1} 翘曲器预算`}
          value={slot.warperBudget}
          disabled={!writable}
          onChange={(event) => submit({ kind: "slot-warper-budget", slotIndex: slot.slotIndex, target: Number(event.target.value) })}
        >{([1, 2, 3, 4] as const).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      </> : null}
    </fieldset>)}
    {configuration.itemOptions.truncated
      ? <small>Rust 物品目录超过 {configuration.itemOptions.limit} 条；这里只允许选择本次有界投影中的前 {configuration.itemOptions.rows.length} 条，不会从旧网页状态补读。</small>
      : null}
  </section>
  {confirmationIsCurrent && pendingSlotItemChange ? <AccessibleDialog
    open
    title="确认更换物流站槽位物品"
    ariaLabel="确认更换物流站槽位物品"
    role="alertdialog"
    riskPolicy="explicit"
    className="native-station-slot-item-confirm"
    initialFocusRef={confirmationCancelRef}
    onRequestClose={() => {
      confirmationSubmittingRef.current = false;
      setPendingSlotItemChange(null);
    }}
  >
    <p>槽位 {pendingSlotItemChange.slotIndex + 1} 将从 <strong>{pendingSlotItemChange.previousItemId
      ? optionById.get(pendingSlotItemChange.previousItemId)?.name ?? pendingSlotItemChange.previousItemId
      : "未配置"}</strong> 改为 <strong>{pendingSlotItemChange.targetItemId
      ? optionById.get(pendingSlotItemChange.targetItemId)?.name ?? pendingSlotItemChange.targetItemId
      : "未配置"}</strong>。</p>
    <p>确认后会取消相关物流路线、退款对应缓存与未使用的翘曲器，并拆除匹配旧物品的输入/输出线路。Rust 会从当前权威状态重新计算，界面不会预先修改库存。</p>
    <footer>
      <button ref={confirmationCancelRef} type="button" onClick={() => {
        confirmationSubmittingRef.current = false;
        setPendingSlotItemChange(null);
      }}>取消</button>
      <button className="danger" type="button" onClick={confirmSlotItemChange}>确认更换</button>
    </footer>
  </AccessibleDialog> : null}</>;
}

function NativeEntitySummary({
  entity,
  configuration,
  recipeBinding,
  timeWarpController,
  ejectorOrbitFrame,
  stationConfiguration,
  pending,
  onEntityLockChange,
  onRemoveEntity,
  onStackCountChange,
  onPowerPriorityChange,
  onSplitterDistributionModeChange,
  onEnergyExchangerModeChange,
  onFuelItemChange,
  onEntityRecipeChange,
  onBlackHolePausedChange,
  onGalacticExporterPausedChange,
  onMaterialDeliverySlotChange,
  onOrbitalCargoPortClear,
  onTimeWarpEnabledChange,
  onTimeWarpRequestedMultiplierChange,
  onEjectorOrbitChange,
  onStationConfigurationChange,
}: {
  entity: SelectedEntityReadModel;
  configuration: NativeProjectedEntityConfigurationBinding | null;
  recipeBinding: NativeProjectedEntityRecipeBinding | null;
  timeWarpController: NativeProjectedTimeWarpControllerBinding | null;
  ejectorOrbitFrame: NativeProjectedEjectorOrbitFrame | null;
  stationConfiguration: NativeProjectedStationConfigurationBinding | null;
  pending: boolean;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveEntity: (entityId: string) => void;
  onStackCountChange: (entityId: string, targetCount: number) => void;
  onPowerPriorityChange: (entityId: string, targetPriority: PowerPriority) => void;
  onSplitterDistributionModeChange: (
    entityId: string,
    targetMode: NativeProjectedSplitterDistributionMode,
  ) => void;
  onEnergyExchangerModeChange: (
    entityId: string,
    targetMode: NativeProjectedEnergyExchangerMode,
  ) => void;
  onFuelItemChange: (entityId: string, targetItemId: ItemId) => void;
  onEntityRecipeChange?: (entityId: string, targetRecipeId: RecipeId) => void;
  onBlackHolePausedChange: (
    entityId: string,
    paused: boolean,
  ) => void;
  onGalacticExporterPausedChange?: (entityId: string, paused: boolean) => void;
  onMaterialDeliverySlotChange?: (
    entityId: string,
    slotIndex: number,
    mode: MaterialDeliverySlotMode,
    itemId: ItemId | null,
  ) => void;
  onOrbitalCargoPortClear?: (entityId: string, portIndex: number) => void;
  onTimeWarpEnabledChange?: (entityId: string, enabled: boolean) => void;
  onTimeWarpRequestedMultiplierChange?: (entityId: string, requestedMultiplier: number) => void;
  onEjectorOrbitChange?: (entityId: string, orbitId: string) => void;
  onStationConfigurationChange?: (entityId: string, action: NativeStationConfigurationUiAction) => void;
}) {
  const label = entity.buildingId
    ? constructionNames.get(entity.buildingId) ?? entity.buildingId
    : entity.resourceId ? itemLabel(entity.resourceId) : entity.entityId;
  const powerPriority = getNativeProjectedPowerPriority(configuration);
  const splitterDistributionMode = getNativeProjectedSplitterDistributionMode(configuration);
  const energyExchangerMode = getNativeProjectedEnergyExchangerMode(configuration);
  const energyExchangerSwitchable = canNativeProjectedEnergyExchangerModeChange(configuration);
  const fuelConfiguration = getNativeProjectedFuelItemConfiguration(configuration);
  const materialDeliveryConfiguration = getNativeProjectedMaterialDeliveryConfiguration(configuration);
  const orbitalCargoConfiguration = getNativeProjectedOrbitalCargoConfiguration(configuration);
  const galacticExporterPaused = configuration?.entity.buildingId === "galactic_material_exporter" &&
    typeof configuration.entity.galacticExporterPaused === "boolean"
    ? configuration.entity.galacticExporterPaused
    : null;
  const recipeConfiguration = getNativeProjectedEntityRecipeConfiguration(recipeBinding);
  const recipeEligible = entity.kind === "machine" &&
    isNativeProjectedOrdinaryRecipeBuilding(entity.buildingId);
  const [pendingRecipeChange, setPendingRecipeChange] = useState<PendingNativeEntityRecipeChange | null>(null);
  const [pendingSpecialPortChange, setPendingSpecialPortChange] = useState<PendingNativeSpecialInputPortChange | null>(null);
  const specialPortConfirmationCancelRef = useRef<HTMLButtonElement | null>(null);
  const recipeConfirmationCancelRef = useRef<HTMLButtonElement | null>(null);
  const recipeConfirmationSubmittingRef = useRef(false);
  useEffect(() => {
    setPendingRecipeChange(null);
    recipeConfirmationSubmittingRef.current = false;
  }, [
    entity.buildingId,
    entity.entityId,
    entity.interactionLocked,
    entity.planetId,
    entity.recipeId,
    pending,
    recipeBinding?.activePlanetId,
    recipeBinding?.entity.buildingId,
    recipeBinding?.entity.id,
    recipeBinding?.entity.interactionLocked,
    recipeBinding?.entity.planetId,
    recipeBinding?.entity.recipeId,
    recipeBinding?.registryFingerprint,
    recipeBinding?.revision,
    recipeBinding?.runId,
    recipeBinding?.sessionId,
  ]);
  useEffect(() => {
    setPendingSpecialPortChange(null);
  }, [
    configuration?.entity.deliverySlots,
    configuration?.entity.id,
    configuration?.entity.interactionLocked,
    configuration?.entity.orbitalCargoPortItems,
    configuration?.revision,
    configuration?.runId,
    configuration?.sessionId,
    pending,
  ]);
  const recipeWritable = Boolean(recipeBinding && recipeConfiguration && onEntityRecipeChange && !pending);
  const recipeConfirmationIsCurrent = Boolean(recipeBinding && recipeConfiguration && pendingRecipeChange &&
    !pending && pendingRecipeChange.sessionId === recipeBinding.sessionId &&
    pendingRecipeChange.runId === recipeBinding.runId &&
    pendingRecipeChange.revision === recipeBinding.revision &&
    pendingRecipeChange.registryFingerprint === recipeBinding.registryFingerprint &&
    pendingRecipeChange.activePlanetId === recipeBinding.activePlanetId &&
    pendingRecipeChange.entityId === entity.entityId &&
    pendingRecipeChange.entityId === recipeBinding.entity.id &&
    pendingRecipeChange.planetId === entity.planetId &&
    pendingRecipeChange.planetId === recipeBinding.entity.planetId &&
    pendingRecipeChange.currentRecipeId === entity.recipeId &&
    pendingRecipeChange.currentRecipeId === (recipeBinding.entity.recipeId ?? null) &&
    pendingRecipeChange.currentRecipeId === recipeConfiguration.currentRecipeId &&
    pendingRecipeChange.targetRecipeId !== pendingRecipeChange.currentRecipeId &&
    recipeConfiguration.options.some((option) => option.recipeId === pendingRecipeChange.targetRecipeId));
  const confirmRecipeChange = () => {
    if (!recipeConfirmationIsCurrent || !pendingRecipeChange || !recipeWritable ||
        recipeConfirmationSubmittingRef.current) {
      setPendingRecipeChange(null);
      return;
    }
    recipeConfirmationSubmittingRef.current = true;
    const { entityId, targetRecipeId } = pendingRecipeChange;
    setPendingRecipeChange(null);
    onEntityRecipeChange?.(entityId, targetRecipeId);
  };
  const blackHoleState = configuration?.entity.buildingId === "micro_black_hole_connector" &&
    typeof configuration.entity.blackHolePaused === "boolean" &&
    typeof configuration.entity.blackHoleActivationConfirmed === "boolean"
    ? {
      paused: configuration.entity.blackHolePaused,
      activationConfirmed: configuration.entity.blackHoleActivationConfirmed,
    }
    : null;
  const blackHolePorts = blackHoleState && Array.isArray(configuration?.entity.blackHolePorts) &&
    configuration.entity.blackHolePorts.length === 3 && configuration.entity.blackHolePorts.every((port, index) =>
      port.index === index && typeof port.totalDestroyed === "string" && /^\d+$/.test(port.totalDestroyed) &&
      (port.currentItemId === undefined || Object.hasOwn(ITEMS, port.currentItemId)))
    ? configuration.entity.blackHolePorts
    : null;
  const specialPortConfirmationIsCurrent = Boolean(configuration && pendingSpecialPortChange && !pending &&
    configuration.sessionId === pendingSpecialPortChange.sessionId &&
    configuration.runId === pendingSpecialPortChange.runId &&
    configuration.revision === pendingSpecialPortChange.revision &&
    configuration.entity.id === pendingSpecialPortChange.entityId);
  const confirmSpecialPortChange = () => {
    if (!specialPortConfirmationIsCurrent || !pendingSpecialPortChange) {
      setPendingSpecialPortChange(null);
      return;
    }
    const change = pendingSpecialPortChange;
    setPendingSpecialPortChange(null);
    if (change.kind === "material-delivery") {
      onMaterialDeliverySlotChange?.(
        change.entityId,
        change.slotIndex,
        change.mode,
        change.itemId,
      );
    } else {
      onOrbitalCargoPortClear?.(change.entityId, change.portIndex);
    }
  };
  const timeWarpState = getNativeProjectedTimeWarpControllerState(timeWarpController);
  const ejectorTargetId = ejectorOrbitFrame?.entity.targetDysonOrbitId ?? null;
  const toggleBlackHole = () => {
    if (!blackHoleState) return;
    if (!blackHoleState.paused) {
      onBlackHolePausedChange(entity.entityId, true);
      return;
    }
    onBlackHolePausedChange(entity.entityId, false);
  };
  return <>
    <section className="inspector-content native-factory-inspector__entity" aria-label="Windows 原生建筑摘要">
      <div className="inspector-identity"><i className="building-mark"><CircuitBoard size={18} /></i><div><span>Windows 原生建筑</span><strong>{label}</strong></div></div>
      {entity.interactionLocked ? <p className="native-factory-inspector__lock"><LockKeyhole size={13} />建筑已锁定</p> : null}
      <dl className="metric-ledger">
        <div><dt>建筑堆叠</dt><dd>×<QuantityValue value={entity.machineCount} interactive={false} /></dd></div>
        <div><dt>采集设备</dt><dd>×<QuantityValue value={entity.minerCount} interactive={false} /></dd></div>
        <div><dt>周期进度</dt><dd>{Math.round(entity.progress * 100)}%</dd></div>
        <div><dt>当前利用率</dt><dd>{Math.round(entity.utilization * 100)}%</dd></div>
        <div><dt>生产速率</dt><dd><QuantityValue value={entity.productionRate} interactive={false} /></dd></div>
        <div><dt>供电效率</dt><dd>{entity.powerFactor === null ? "-" : `${Math.round(entity.powerFactor * 100)}%`}</dd></div>
      </dl>
      {itemRows("输入缓存", entity.inputItems.rows, entity.inputItems.truncated)}
      {itemRows("输出缓存", entity.outputItems.rows, entity.outputItems.truncated)}
    </section>
    <NativeStationConfiguration
      entity={entity}
      binding={stationConfiguration}
      pending={pending}
      onChange={onStationConfigurationChange}
    />
    <section className="native-inspector-safe-actions" data-native-entity-lock="ordinary-single-v1">
      <strong>Rust 建筑锁定</strong>
      <p>只切换当前建筑的交互锁。Rust 会在最新 revision 再确认实体仍存在，锁定不会改变库存、线路或生产数据。</p>
      <button
        type="button"
        disabled={pending}
        aria-pressed={entity.interactionLocked}
        onClick={() => onEntityLockChange(entity.entityId, !entity.interactionLocked)}
      ><LockKeyhole size={14} />{entity.interactionLocked ? "解除建筑锁定" : "锁定建筑"}</button>
    </section>
    {powerPriority === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-entity-power-priority="ordinary-single-v1"
    >
      <strong>Rust 用电优先级</strong>
      <p>只修改当前内置普通生产建筑。Rust 会在最新 revision 重新核对建筑、行星和原优先级。</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生建筑用电优先级">
        {([3, 2, 1] as const).map((priority) => <button
          type="button"
          key={priority}
          disabled={pending || powerPriority === priority}
          aria-pressed={powerPriority === priority}
          onClick={() => onPowerPriorityChange(entity.entityId, priority)}
        >{priority === 3 ? "高" : priority === 2 ? "中" : "低"}</button>)}
      </div>
    </section>}
    {!recipeEligible ? null : <section
      className="native-inspector-safe-actions"
      data-native-entity-recipe="semantic-intent-v1"
    >
      <strong>Rust 生产配方</strong>
      <p>{recipeConfiguration
        ? "候选只来自已验证的内置目录；锁定科技、建筑族和当前配方会由 Rust 在最新 revision 再次校验，界面不会预先退款、拆线或改写进度。"
        : "当前配方行、内置目录指纹或同 revision 选择尚未完整核对；旧 JavaScript 存档不会作为候选来源。"}</p>
      <label>
        <span>当前配方</span>
        <select
          aria-label="Windows 原生生产配方"
          value={recipeConfiguration?.currentRecipeId ?? entity.recipeId ?? ""}
          disabled={!recipeWritable}
          onChange={(event) => {
            if (!recipeBinding || !recipeConfiguration || !recipeWritable) return;
            const targetRecipeId = event.currentTarget.value as RecipeId;
            if (targetRecipeId === recipeConfiguration.currentRecipeId ||
                !recipeConfiguration.options.some((option) => option.recipeId === targetRecipeId)) return;
            recipeConfirmationSubmittingRef.current = false;
            setPendingRecipeChange({
              sessionId: recipeBinding.sessionId,
              runId: recipeBinding.runId,
              revision: recipeBinding.revision,
              registryFingerprint: recipeBinding.registryFingerprint,
              activePlanetId: recipeBinding.activePlanetId,
              entityId: recipeBinding.entity.id,
              planetId: recipeBinding.entity.planetId,
              currentRecipeId: recipeConfiguration.currentRecipeId,
              targetRecipeId,
            });
          }}
        >
          {!recipeConfiguration ? <option value={entity.recipeId ?? ""}>
            {entity.recipeId ? `${entity.recipeId}（等待原生目录）` : "等待原生配方目录"}
          </option> : <>
            {recipeConfiguration.currentRecipeId === null ? <option value="" disabled>选择配方</option> : null}
            {recipeConfiguration.options.map((option) => <option value={option.recipeId} key={option.recipeId}>
              {option.name}
            </option>)}
          </>}
        </select>
      </label>
    </section>}
    {recipeConfirmationIsCurrent && pendingRecipeChange ? <AccessibleDialog
      open
      title="确认更换生产配方"
      ariaLabel="确认更换生产配方"
      role="alertdialog"
      riskPolicy="explicit"
      className="native-entity-recipe-confirm"
      initialFocusRef={recipeConfirmationCancelRef}
      onRequestClose={() => {
        recipeConfirmationSubmittingRef.current = false;
        setPendingRecipeChange(null);
      }}
    >
      <p>当前建筑将从 <strong>{recipeConfiguration?.options.find((option) =>
        option.recipeId === pendingRecipeChange.currentRecipeId)?.name ?? pendingRecipeChange.currentRecipeId ?? "未配置"}</strong> 改为 <strong>{recipeConfiguration?.options.find((option) =>
        option.recipeId === pendingRecipeChange.targetRecipeId)?.name ?? pendingRecipeChange.targetRecipeId}</strong>。</p>
      <p>确认后 Rust 会从最新权威状态退款该建筑的输入、输出缓存，拆除所有相邻传送带并返还线路物资，同时重置生产进度；界面不会预先改写这些数据。</p>
      <footer>
        <button ref={recipeConfirmationCancelRef} type="button" onClick={() => {
          recipeConfirmationSubmittingRef.current = false;
          setPendingRecipeChange(null);
        }}>取消</button>
        <button className="danger" type="button" onClick={confirmRecipeChange}>确认更换配方</button>
      </footer>
    </AccessibleDialog> : null}
    {splitterDistributionMode === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-splitter-mode="ordinary-single-v1"
    >
      <strong>Rust 分流模式</strong>
      <p>只修改当前内置四向分流器；线路和在途物料不会在界面中预先改写。</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生分流器模式">
        {(["balanced", "priority"] as const).map((mode) => <button
          type="button"
          key={mode}
          disabled={pending || splitterDistributionMode === mode}
          aria-pressed={splitterDistributionMode === mode}
          onClick={() => onSplitterDistributionModeChange(entity.entityId, mode)}
        >{mode === "balanced" ? "均衡" : "优先线路"}</button>)}
      </div>
    </section>}
    {energyExchangerMode === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-energy-exchanger-mode="ordinary-single-v1"
    >
      <strong>Rust 能量枢纽模式</strong>
      <p>{energyExchangerSwitchable
        ? "切换后由 Rust 原子返还输入输出、回收相连线路，并重新设置配方和生产进度；界面不会预先改写。"
        : "枢纽仍有储能，必须先放空；当前模式和存档不会被界面擅自改写。"}</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生能量枢纽模式">
        {(["charge", "discharge"] as const).map((mode) => <button
          type="button"
          key={mode}
          disabled={pending || !energyExchangerSwitchable || energyExchangerMode === mode}
          aria-pressed={energyExchangerMode === mode}
          onClick={() => onEnergyExchangerModeChange(entity.entityId, mode)}
        >{mode === "charge" ? "空蓄电器充电" : "满蓄电器放电"}</button>)}
      </div>
    </section>}
    {fuelConfiguration === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-fuel-item="ordinary-single-v1"
    >
      <strong><Flame size={14} />Rust 燃料类型</strong>
      <p>只提交目标燃料 ID。Rust 会按最新 revision 原子返还输入缓存、回收相邻线路、返还传送带并重置出力；界面不会预先改写。</p>
      <label>
        <span>当前燃料</span>
        <select
          aria-label="Windows 原生燃料类型"
          value={fuelConfiguration.currentItemId ?? ""}
          disabled={pending}
          onChange={(event) => onFuelItemChange(entity.entityId, event.target.value as ItemId)}
        >
          <option value="" disabled>选择燃料</option>
          {fuelConfiguration.itemIds.map((itemId) => <option value={itemId} key={itemId}>
            {itemLabel(itemId)} · {FUEL_ENERGY_MJ[itemId]} MJ
          </option>)}
        </select>
      </label>
    </section>}
    {materialDeliveryConfiguration === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-material-delivery="semantic-intent-v1"
    >
      <strong><Database size={14} />Rust 物资配送接口</strong>
      <p>接口改动会先二次确认；Rust 再从当前 revision 计算断线、传送带返还、缓存回托盘和兼容镜像，界面不提交这些结果。</p>
      <div className="delivery-hub-slots" aria-label="Windows 原生物资配送接口">
        {materialDeliveryConfiguration.slots.map((slot, slotIndex) => <article
          className={`delivery-hub-slot delivery-hub-slot--${slot.mode}`}
          key={slotIndex}
        >
          <header><strong>接口 {slotIndex + 1}</strong><small>{slot.mode === "manual"
            ? "指定物资" : slot.mode === "disabled" ? "已清空" : "自动识别"}</small></header>
          <label><span>目标物资</span><select
            aria-label={`Windows 原生配送接口 ${slotIndex + 1} 物资`}
            disabled={pending || !onMaterialDeliverySlotChange}
            value={slot.itemId ?? ""}
            onChange={(event) => {
              const itemId = event.currentTarget.value as ItemId;
              if (!itemId || !configuration) return;
              setPendingSpecialPortChange({
                kind: "material-delivery",
                sessionId: configuration.sessionId,
                runId: configuration.runId,
                revision: configuration.revision,
                entityId: entity.entityId,
                slotIndex,
                mode: "manual",
                itemId,
              });
            }}
          ><option value="" disabled>选择物资</option>{materialDeliveryConfiguration.itemIds.map((itemId) =>
            <option value={itemId} key={itemId}>{itemLabel(itemId)}</option>)}</select></label>
          <div className="delivery-hub-slot-actions">
            {(["auto", "disabled"] as const).map((mode) => <button
              type="button"
              key={mode}
              className={slot.mode === mode ? "active" : mode === "disabled" ? "danger" : ""}
              disabled={pending || !onMaterialDeliverySlotChange || slot.mode === mode && slot.itemId === null}
              onClick={() => configuration && setPendingSpecialPortChange({
                kind: "material-delivery",
                sessionId: configuration.sessionId,
                runId: configuration.runId,
                revision: configuration.revision,
                entityId: entity.entityId,
                slotIndex,
                mode,
                itemId: null,
              })}
            >{mode === "auto" ? "恢复自动" : "清空接口"}</button>)}
          </div>
        </article>)}
      </div>
    </section>}
    {orbitalCargoConfiguration === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-orbital-cargo-ports="semantic-intent-v1"
    >
      <strong><Satellite size={14} />Rust 轨道货运接口</strong>
      <p>清空只发送接口编号。Rust 会返还该口传送带；仅当同物品不再被其他接口使用时，缓存才回到当前行星托盘。</p>
      <div className="delivery-hub-slots" aria-label="Windows 原生轨道货运接口">
        {orbitalCargoConfiguration.portItems.map((itemId, portIndex) => <article
          className={`delivery-hub-slot${itemId ? " configured" : ""}`}
          key={portIndex}
        >
          <header><strong>上传口 {portIndex + 1}</strong><small>{itemId ? itemLabel(itemId) : "等待线路识别"}</small></header>
          {itemId ? <><span>缓存 <QuantityValue value={configuration?.entity.inputs[itemId] ?? 0} interactive={false} /></span><button
            type="button"
            className="danger"
            disabled={pending || !onOrbitalCargoPortClear}
            onClick={() => configuration && setPendingSpecialPortChange({
              kind: "orbital-cargo-clear",
              sessionId: configuration.sessionId,
              runId: configuration.runId,
              revision: configuration.revision,
              entityId: entity.entityId,
              portIndex,
              itemId,
            })}
          ><RotateCcw size={13} />安全清空</button></> : null}
        </article>)}
      </div>
    </section>}
    {specialPortConfirmationIsCurrent && pendingSpecialPortChange ? <AccessibleDialog
      open
      title={pendingSpecialPortChange.kind === "material-delivery" ? "确认修改配送接口" : "确认清空轨道货运接口"}
      ariaLabel="确认特殊物流接口修改"
      role="alertdialog"
      riskPolicy="explicit"
      className="native-special-input-port-confirm"
      initialFocusRef={specialPortConfirmationCancelRef}
      onRequestClose={() => setPendingSpecialPortChange(null)}
    >
      <p>{pendingSpecialPortChange.kind === "material-delivery"
        ? `接口 ${pendingSpecialPortChange.slotIndex + 1} 将改为${pendingSpecialPortChange.mode === "manual" ? `指定 ${itemLabel(pendingSpecialPortChange.itemId!)}` : pendingSpecialPortChange.mode === "auto" ? "自动识别" : "停止接收"}。`
        : `上传口 ${pendingSpecialPortChange.portIndex + 1} 的 ${itemLabel(pendingSpecialPortChange.itemId)} 绑定将被清空。`}</p>
      <p>相关线路和缓存会由 Rust 按最新权威状态安全返还；已经上传或送达的物资不会重复退款。</p>
      <footer><button ref={specialPortConfirmationCancelRef} type="button" onClick={() => setPendingSpecialPortChange(null)}>取消</button><button className="danger" type="button" onClick={confirmSpecialPortChange}>确认并提交</button></footer>
    </AccessibleDialog> : null}
    {galacticExporterPaused === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-galactic-exporter-paused="semantic-intent-v1"
    >
      <strong><Factory size={14} />Rust 银河出口建筑</strong>
      <p>这里只提交暂停目标。Rust 会在最新 revision 再确认当前行星、内置目录、实体锁和原开关；输入缓存和累计出口不会由界面修改。</p>
      <button
        type="button"
        disabled={pending || entity.interactionLocked || !onGalacticExporterPausedChange}
        aria-pressed={!galacticExporterPaused}
        onClick={() => onGalacticExporterPausedChange?.(entity.entityId, !galacticExporterPaused)}
      >{galacticExporterPaused ? <Play size={14} /> : <Pause size={14} />}
        {galacticExporterPaused ? "启动银河出口" : "暂停银河出口"}</button>
    </section>}
    {blackHoleState === null ? null : <section
      className="native-inspector-safe-actions"
      data-native-black-hole-paused="micro-black-hole-v1"
    >
      <strong><Atom size={14} />Rust 微型黑洞</strong>
      <p>输入物资将被永久销毁且无法找回。Rust 会在 durable revision 再核对行星、内置目录、实体锁与首次启动确认。</p>
      <dl className="metric-ledger">
        <div><dt>运行开关</dt><dd>{blackHoleState.paused ? "已暂停" : "销毁中"}</dd></div>
        <div><dt>启动确认</dt><dd>{blackHoleState.activationConfirmed ? "已确认" : "尚未确认"}</dd></div>
      </dl>
      {blackHolePorts ? <div className="native-inspector-items" aria-label="微型黑洞累计销毁账本">{blackHolePorts.map((port) => <div key={port.index}>
        <span>接口 {port.index + 1} · {port.currentItemId ? itemLabel(port.currentItemId) : "等待物资"}</span>
        <QuantityValue value={port.totalDestroyed} interactive={false} />
      </div>)}</div> : <p role="status">销毁账本尚未通过同 revision 完整性校验。</p>}
      <button
        type="button"
        disabled={pending || entity.interactionLocked}
        onClick={toggleBlackHole}
      >{blackHoleState.paused ? <Play size={14} /> : <Pause size={14} />}
        {blackHoleState.paused ? "启动微型黑洞" : "暂停销毁"}</button>
    </section>}
    {entity.buildingId !== "time_warp_device" ? null : <section
      className="native-inspector-safe-actions"
      data-native-time-warp-controller="semantic-intent-v1"
    >
      <strong><Gauge size={14} />Rust 时间扭曲主控</strong>
      {timeWarpState ? <>
        <p>界面只提交主控 ID 和目标值；倍率、供电和启停后的派生字段全部由 Rust 在最新 revision 重新计算。</p>
        <dl className="metric-ledger">
          <div><dt>运行开关</dt><dd>{timeWarpState.enabled ? "纯挂机运行中" : "已停止"}</dd></div>
          <div><dt>请求倍率</dt><dd>{timeWarpState.requestedMultiplier}x</dd></div>
          <div><dt>实际倍率</dt><dd>{timeWarpState.effectiveMultiplier}x</dd></div>
          <div><dt>需求功率</dt><dd><PowerValue valueKw={timeWarpState.requiredPowerKw} /></dd></div>
          <div><dt>获得功率</dt><dd><PowerValue valueKw={timeWarpState.allocatedPowerKw} /></dd></div>
        </dl>
        <div className="time-warp-stepper" aria-label="Windows 原生时间扭曲请求倍率">
          <button
            type="button"
            aria-label="原生倍率减一"
            disabled={pending || timeWarpState.requestedMultiplier <= 5 || !onTimeWarpRequestedMultiplierChange}
            onClick={() => onTimeWarpRequestedMultiplierChange?.(
              entity.entityId,
              timeWarpState.requestedMultiplier - 1,
            )}
          >-</button>
          <input
            type="number"
            min={5}
            step={1}
            value={timeWarpState.requestedMultiplier}
            disabled={pending || !onTimeWarpRequestedMultiplierChange}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isSafeInteger(value) && value >= 5) {
                onTimeWarpRequestedMultiplierChange?.(entity.entityId, value);
              }
            }}
          />
          <button
            type="button"
            aria-label="原生倍率加一"
            disabled={pending || timeWarpState.requestedMultiplier >= Number.MAX_SAFE_INTEGER ||
              !onTimeWarpRequestedMultiplierChange}
            onClick={() => onTimeWarpRequestedMultiplierChange?.(
              entity.entityId,
              timeWarpState.requestedMultiplier + 1,
            )}
          >+</button>
        </div>
        <button
          type="button"
          disabled={pending || !onTimeWarpEnabledChange}
          onClick={() => onTimeWarpEnabledChange?.(entity.entityId, !timeWarpState.enabled)}
        >{timeWarpState.enabled ? <Pause size={14} /> : <Play size={14} />}
          {timeWarpState.enabled ? "安全停止原生纯挂机" : "开始原生纯挂机"}</button>
      </> : <p role="status">当前建筑不是同 revision 的已选主控，或原生投影正在刷新；控制保持关闭。</p>}
    </section>}
    {entity.buildingId !== "em_rail_ejector" ? null : <section
      className="native-inspector-safe-actions"
      data-native-ejector-orbit="entity-leaf-v1"
    >
      <strong><Orbit size={14} />Rust 太阳帆目标轨道</strong>
      {ejectorOrbitFrame ? <>
        <p>这里只读取当前恒星系最多 8 条原生轨道；提交时只发送弹射器 ID 和目标轨道 ID。</p>
        <label>
          <span>目标轨道</span>
          <select
            aria-label="Windows 原生太阳帆目标轨道"
            value={ejectorTargetId ?? ""}
            disabled={pending || !onEjectorOrbitChange}
            onChange={(event) => onEjectorOrbitChange?.(entity.entityId, event.target.value)}
          >
            {ejectorTargetId && !ejectorOrbitFrame.orbitsById.has(ejectorTargetId)
              ? <option value={ejectorTargetId}>失效轨道 · {ejectorTargetId}</option>
              : null}
            {!ejectorTargetId ? <option value="" disabled>选择轨道</option> : null}
            {ejectorOrbitFrame.orbits.map((orbit) => <option
              value={orbit.orbitId}
              key={orbit.orbitId}
            >{orbit.name || orbit.orbitId} · {orbit.radius.toLocaleString("zh-CN")} m</option>)}
          </select>
        </label>
      </> : <p role="status">正在核对当前恒星系的同 revision 轨道页；旧网页存档不会作为备用来源。</p>}
    </section>}
    <section className="native-inspector-safe-actions" data-native-construction-stack="ordinary-single-v1">
      <strong>Rust 建筑堆叠</strong>
      <p>每次只增减一栋。Rust 会用最新 revision 重新核对建筑上限和施工托盘；旧档中超过新上限的堆叠仍可安全减少。</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生建筑堆叠调整">
        <button
          type="button"
          disabled={pending || entity.interactionLocked || !entity.buildingId || entity.machineCount <= 1}
          onClick={() => onStackCountChange(entity.entityId, entity.machineCount - 1)}
          aria-label="减少一栋建筑堆叠"
        ><Minus size={14} />减少到 ×{Math.max(1, entity.machineCount - 1)}</button>
        <button
          type="button"
          disabled={pending || entity.interactionLocked || !entity.buildingId || entity.machineCount >= Number.MAX_SAFE_INTEGER}
          onClick={() => onStackCountChange(entity.entityId, entity.machineCount + 1)}
          aria-label="增加一栋建筑堆叠"
        ><Plus size={14} />增加到 ×{entity.machineCount + 1}</button>
      </div>
    </section>
    <section className="native-inspector-safe-actions" data-native-construction-removal="ordinary-complete-v1">
      <strong>Rust 安全回收</strong>
      <p>仅完整回收这一整组普通建筑。Rust 会在最后一刻重新检查缓存、线路、喷涂模块、施工引用和返还上限。</p>
      <button
        className="danger"
        type="button"
        disabled={pending || entity.interactionLocked || !entity.buildingId || entity.machineCount < 1}
        onClick={() => onRemoveEntity(entity.entityId)}
      ><Trash2 size={14} />{pending ? "正在向 Rust 确认" : "安全回收整组建筑"}</button>
    </section>
  </>;
}

function NativeBeltSummary({ belt, pending, onLaneCountChange, onPriorityChange, onRemove }: {
  belt: SelectedBeltReadModel;
  pending: boolean;
  onLaneCountChange: (beltId: string, targetLanes: number) => void;
  onPriorityChange: (beltId: string, targetPriority: 0 | 1 | 2) => void;
  onRemove: (beltId: string) => void;
}) {
  return <>
    <section className="inspector-content native-factory-inspector__belt" aria-label="Windows 原生传送带摘要">
      <div className="inspector-identity"><i className="building-mark"><Route size={18} /></i><div><span>Windows 原生线路</span><strong>{itemLabel(belt.itemId)}</strong></div></div>
      <dl className="metric-ledger">
        <div><dt>等级</dt><dd>Mk.{belt.tier}</dd></div>
        <div><dt>并联数量</dt><dd>×<QuantityValue value={belt.lanes} interactive={false} /></dd></div>
        <div><dt>分拣器等级</dt><dd>Mk.{belt.sorterTier}</dd></div>
        <div><dt>堆叠</dt><dd>{belt.stackSize ?? 1}</dd></div>
        <div><dt>瞬时流量</dt><dd><QuantityValue value={belt.lastFlow} interactive={false} /></dd></div>
        <div><dt>累计运输</dt><dd>{belt.totalTransferred === null ? "-" : <QuantityValue value={belt.totalTransferred} interactive={false} />}</dd></div>
        <div><dt>拥堵</dt><dd>{belt.congestion === null ? "-" : `${Math.round(belt.congestion * 100)}%`}</dd></div>
      </dl>
      <p className="native-factory-inspector__route">{belt.sourceEntityId} → {belt.targetEntityId}</p>
    </section>
    <section className="native-inspector-safe-actions" data-native-belt-lanes="ordinary-single-v1">
      <strong>Rust 并联线路</strong>
      <p>每次只增减一条并联线路。Rust 会用最新 revision 核对端点、等级、当前数量和施工托盘，再原子扣除或返还同级传送带。</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生并联线路调整">
        <button
          type="button"
          disabled={pending || belt.lanes <= 1}
          onClick={() => onLaneCountChange(belt.beltId, belt.lanes - 1)}
          aria-label="减少一条并联线路"
        ><Minus size={14} />减少到 ×{Math.max(1, belt.lanes - 1)}</button>
        <button
          type="button"
          disabled={pending || !Number.isSafeInteger(belt.lanes) || belt.lanes >= 4096}
          onClick={() => onLaneCountChange(belt.beltId, belt.lanes + 1)}
          aria-label="增加一条并联线路"
        ><Plus size={14} />增加到 ×{belt.lanes + 1}</button>
      </div>
    </section>
    <section className="native-inspector-safe-actions" data-native-belt-priority="ordinary-single-v1">
      <strong>Rust 线路优先级</strong>
      <p>只修改当前这一条线路；Rust 会核对最新 revision 和原优先级后再提交。</p>
      <div className="native-inspector-stack-actions" role="group" aria-label="Windows 原生线路优先级">
        {([0, 1, 2] as const).map((priority) => <button
          type="button"
          key={priority}
          disabled={pending || belt.priority === priority}
          aria-pressed={belt.priority === priority}
          onClick={() => onPriorityChange(belt.beltId, priority)}
        >{priority === 0 ? "低" : priority === 1 ? "标准" : "高"}</button>)}
      </div>
    </section>
    <section className="native-inspector-safe-actions" data-native-belt-removal="ordinary-single-v1">
      <strong>Rust 安全拆线</strong>
      <p>每次只回收一条内置 Mk.I–III 普通线路，并按实际并联数量原子返还施工托盘。</p>
      <button
        className="danger"
        type="button"
        disabled={pending}
        onClick={() => onRemove(belt.beltId)}
      ><Trash2 size={14} />{pending ? "正在向 Rust 确认" : "安全回收这条线路"}</button>
    </section>
  </>;
}

/** A truly thin inspector: no full-state prop and no legacy fallback. */
export function NativeFactoryInspectorPanel({
  inspector,
  multiSelection,
  entityConfiguration,
  entityRecipeBinding = null,
  timeWarpController = null,
  ejectorOrbitFrame = null,
  stationConfiguration = null,
  pending,
  onEntityLockChange,
  onRemoveEntity,
  onStackCountChange,
  onEntityPowerPriorityChange,
  onSplitterDistributionModeChange,
  onEnergyExchangerModeChange,
  onFuelItemChange,
  onEntityRecipeChange,
  onBlackHolePausedChange,
  onGalacticExporterPausedChange,
  onMaterialDeliverySlotChange,
  onOrbitalCargoPortClear,
  onTimeWarpEnabledChange,
  onTimeWarpRequestedMultiplierChange,
  onEjectorOrbitChange,
  onStationConfigurationChange,
  onBeltLaneCountChange,
  onBeltPriorityChange,
  onRemoveBelt,
}: NativeFactoryInspectorPanelProps) {
  const ready = inspector.schema === "factory-read-model-v1" &&
    inspector.source === "native-core" && Number.isSafeInteger(inspector.revision) &&
    (inspector.revision ?? -1) >= 0 && multiSelection.schema === inspector.schema &&
    multiSelection.source === "native-core" && multiSelection.revision === inspector.revision &&
    multiSelection.activePlanetId === inspector.activePlanetId;
  const selectedCount = multiSelection.requestedEntityCount + multiSelection.requestedBeltCount;
  const projectionIdentity = multiSelection.projectionIdentity;
  const currentEntityConfiguration = ready && inspector.entity && entityConfiguration &&
    projectionIdentity && entityConfiguration.sessionId === projectionIdentity.sessionId &&
    entityConfiguration.runId === projectionIdentity.runId &&
    entityConfiguration.revision === projectionIdentity.revision &&
    entityConfiguration.activePlanetId === projectionIdentity.planetId &&
    entityConfiguration.entity.id === inspector.entity.entityId &&
    entityConfiguration.entity.planetId === inspector.entity.planetId &&
    entityConfiguration.entity.kind === inspector.entity.kind &&
    entityConfiguration.entity.buildingId === (inspector.entity.buildingId ?? undefined) &&
    (entityConfiguration.entity.recipeId ?? null) === inspector.entity.recipeId &&
    (entityConfiguration.entity.fuelItemId ?? null) === inspector.entity.fuelItemId &&
    entityConfiguration.entity.interactionLocked === inspector.entity.interactionLocked
    ? entityConfiguration
    : null;
  const currentEntityRecipeBinding = currentEntityConfiguration && entityRecipeBinding && projectionIdentity &&
    entityRecipeBinding.sessionId === projectionIdentity.sessionId &&
    entityRecipeBinding.runId === projectionIdentity.runId &&
    entityRecipeBinding.revision === projectionIdentity.revision &&
    entityRecipeBinding.activePlanetId === projectionIdentity.planetId &&
    entityRecipeBinding.sessionId === currentEntityConfiguration.sessionId &&
    entityRecipeBinding.runId === currentEntityConfiguration.runId &&
    entityRecipeBinding.revision === currentEntityConfiguration.revision &&
    entityRecipeBinding.activePlanetId === currentEntityConfiguration.activePlanetId &&
    entityRecipeBinding.entity.id === currentEntityConfiguration.entity.id &&
    entityRecipeBinding.entity.planetId === currentEntityConfiguration.entity.planetId &&
    entityRecipeBinding.entity.kind === currentEntityConfiguration.entity.kind &&
    entityRecipeBinding.entity.buildingId === currentEntityConfiguration.entity.buildingId &&
    (entityRecipeBinding.entity.recipeId ?? null) === (currentEntityConfiguration.entity.recipeId ?? null) &&
    entityRecipeBinding.entity.interactionLocked === currentEntityConfiguration.entity.interactionLocked
    ? entityRecipeBinding
    : null;
  const currentTimeWarpController = currentEntityConfiguration && timeWarpController &&
    timeWarpController.sessionId === currentEntityConfiguration.sessionId &&
    timeWarpController.runId === currentEntityConfiguration.runId &&
    timeWarpController.revision === currentEntityConfiguration.revision &&
    timeWarpController.activePlanetId === currentEntityConfiguration.activePlanetId &&
    timeWarpController.entity.id === currentEntityConfiguration.entity.id &&
    timeWarpController.entity.planetId === currentEntityConfiguration.entity.planetId &&
    timeWarpController.entity.kind === currentEntityConfiguration.entity.kind &&
    timeWarpController.entity.buildingId === currentEntityConfiguration.entity.buildingId &&
    timeWarpController.entity.interactionLocked === currentEntityConfiguration.entity.interactionLocked
    ? timeWarpController
    : null;
  const currentEjectorOrbitFrame = currentEntityConfiguration && ejectorOrbitFrame &&
    ejectorOrbitFrame.sessionId === currentEntityConfiguration.sessionId &&
    ejectorOrbitFrame.runId === currentEntityConfiguration.runId &&
    ejectorOrbitFrame.revision === currentEntityConfiguration.revision &&
    ejectorOrbitFrame.activePlanetId === currentEntityConfiguration.activePlanetId &&
    ejectorOrbitFrame.entity.id === currentEntityConfiguration.entity.id &&
    ejectorOrbitFrame.entity.planetId === currentEntityConfiguration.entity.planetId &&
    ejectorOrbitFrame.entity.kind === currentEntityConfiguration.entity.kind &&
    ejectorOrbitFrame.entity.buildingId === currentEntityConfiguration.entity.buildingId &&
    ejectorOrbitFrame.entity.interactionLocked === currentEntityConfiguration.entity.interactionLocked &&
    ejectorOrbitFrame.entity.targetDysonOrbitId === currentEntityConfiguration.entity.targetDysonOrbitId
    ? ejectorOrbitFrame
    : null;
  const currentStationConfiguration = ready && inspector.entity && stationConfiguration &&
    projectionIdentity && stationConfiguration.sessionId === projectionIdentity.sessionId &&
    stationConfiguration.runId === projectionIdentity.runId &&
    stationConfiguration.revision === projectionIdentity.revision &&
    stationConfiguration.activePlanetId === projectionIdentity.planetId &&
    stationConfiguration.entity.entityId === inspector.entity.entityId &&
    stationConfiguration.entity.planetId === inspector.entity.planetId &&
    stationConfiguration.entity.kind === inspector.entity.kind &&
    stationConfiguration.entity.buildingId === inspector.entity.buildingId &&
    stationConfiguration.entity.interactionLocked === inspector.entity.interactionLocked &&
    stationConfiguration.configuration === inspector.entity.stationConfiguration
    ? stationConfiguration
    : null;
  let content;
  if (!ready) {
    content = <section className="inspector-content native-read-only-unavailable" role="status"><strong>正在核对原生检查摘要</strong><p>旧 JavaScript 存档不会作为备用显示来源。</p></section>;
  } else if (selectedCount > 1) {
    const complete = !multiSelection.entityRows.truncated && !multiSelection.beltRows.truncated &&
      multiSelection.entityRows.totalCount === multiSelection.requestedEntityCount &&
      multiSelection.beltRows.totalCount === multiSelection.requestedBeltCount;
    content = <section className="inspector-content native-read-only-multi-selection" aria-label="Windows 原生多选摘要">
      <div className="inspector-identity"><i className="building-mark"><Layers3 size={18} /></i><div><span>Windows 原生多选</span><strong>{multiSelection.requestedEntityCount} 个建筑 · {multiSelection.requestedBeltCount} 条线路</strong></div></div>
      <p>{complete ? "多选内容已经由同 revision 的 Rust 投影完整确认。" : "选择超过有界投影上限；修改功能保持关闭。"}</p>
    </section>;
  } else if (inspector.entity && !inspector.belt) {
    content = <NativeEntitySummary
      entity={inspector.entity}
      configuration={currentEntityConfiguration}
      recipeBinding={currentEntityRecipeBinding}
      timeWarpController={currentTimeWarpController}
      ejectorOrbitFrame={currentEjectorOrbitFrame}
      stationConfiguration={currentStationConfiguration}
      pending={pending}
      onEntityLockChange={onEntityLockChange}
      onRemoveEntity={onRemoveEntity}
      onStackCountChange={onStackCountChange}
      onPowerPriorityChange={onEntityPowerPriorityChange}
      onSplitterDistributionModeChange={onSplitterDistributionModeChange}
      onEnergyExchangerModeChange={onEnergyExchangerModeChange}
      onFuelItemChange={onFuelItemChange}
      onEntityRecipeChange={onEntityRecipeChange}
      onBlackHolePausedChange={onBlackHolePausedChange}
      onGalacticExporterPausedChange={onGalacticExporterPausedChange}
      onMaterialDeliverySlotChange={onMaterialDeliverySlotChange}
      onOrbitalCargoPortClear={onOrbitalCargoPortClear}
      onTimeWarpEnabledChange={onTimeWarpEnabledChange}
      onTimeWarpRequestedMultiplierChange={onTimeWarpRequestedMultiplierChange}
      onEjectorOrbitChange={onEjectorOrbitChange}
      onStationConfigurationChange={onStationConfigurationChange}
    />;
  } else if (inspector.belt && !inspector.entity) {
    content = <NativeBeltSummary belt={inspector.belt} pending={pending} onLaneCountChange={onBeltLaneCountChange} onPriorityChange={onBeltPriorityChange} onRemove={onRemoveBelt} />;
  } else {
    content = <section className="inspector-content native-read-only-unavailable" role="status"><strong>请选择一个建筑或传送带</strong><p>这里只显示同 revision 的 Rust 小型投影。</p></section>;
  }
  return <aside
    className="inspector-panel native-factory-inspector"
    data-native-factory-inspector="bounded-v1"
    data-native-revision={ready ? inspector.revision ?? "none" : "pending"}
  >
    <div className="panel-tabs" role="tablist" aria-label="Windows 原生检查器"><button role="tab" aria-selected="true" className="active" type="button" disabled><CircuitBoard size={15} />检查器</button></div>
    {content}
  </aside>;
}
