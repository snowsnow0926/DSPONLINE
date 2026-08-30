import { Atom, CircuitBoard, Flame, Gauge, Layers3, LockKeyhole, Minus, Orbit, Pause, Play, Plus, Route, Trash2 } from "lucide-react";
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
import type { ItemId, LogisticsPriority, PowerPriority, StationMinimumLoad } from "../game/types";
import { AccessibleDialog } from "./AccessibleDialog";
import { PowerValue } from "./PowerValue";
import { QuantityValue } from "./QuantityValue";

interface NativeFactoryInspectorPanelProps {
  inspector: FactoryInspectorSummaryReadModel;
  multiSelection: FactoryMultiSelectionSummaryReadModel;
  entityConfiguration: NativeProjectedEntityConfigurationBinding | null;
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
  onBlackHolePausedChange: (
    entityId: string,
    paused: boolean,
  ) => void;
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
  onBlackHolePausedChange,
  onTimeWarpEnabledChange,
  onTimeWarpRequestedMultiplierChange,
  onEjectorOrbitChange,
  onStationConfigurationChange,
}: {
  entity: SelectedEntityReadModel;
  configuration: NativeProjectedEntityConfigurationBinding | null;
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
  onBlackHolePausedChange: (
    entityId: string,
    paused: boolean,
  ) => void;
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
  const blackHoleState = configuration?.entity.buildingId === "micro_black_hole_connector" &&
    typeof configuration.entity.blackHolePaused === "boolean" &&
    typeof configuration.entity.blackHoleActivationConfirmed === "boolean"
    ? {
      paused: configuration.entity.blackHolePaused,
      activationConfirmed: configuration.entity.blackHoleActivationConfirmed,
    }
    : null;
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
  onBlackHolePausedChange,
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
    (entityConfiguration.entity.fuelItemId ?? null) === inspector.entity.fuelItemId &&
    entityConfiguration.entity.interactionLocked === inspector.entity.interactionLocked
    ? entityConfiguration
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
      onBlackHolePausedChange={onBlackHolePausedChange}
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
