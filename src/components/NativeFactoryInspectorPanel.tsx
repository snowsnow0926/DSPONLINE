import { Atom, CircuitBoard, Flame, Layers3, LockKeyhole, Minus, Pause, Play, Plus, Route, Trash2 } from "lucide-react";
import { CONSTRUCTION, FUEL_ENERGY_MJ, ITEMS } from "../game/content";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  ItemQuantityReadModel,
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
import type { ItemId, PowerPriority } from "../game/types";
import { QuantityValue } from "./QuantityValue";

interface NativeFactoryInspectorPanelProps {
  inspector: FactoryInspectorSummaryReadModel;
  multiSelection: FactoryMultiSelectionSummaryReadModel;
  entityConfiguration: NativeProjectedEntityConfigurationBinding | null;
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
  onBeltLaneCountChange: (beltId: string, targetLanes: number) => void;
  onBeltPriorityChange: (beltId: string, targetPriority: 0 | 1 | 2) => void;
  onRemoveBelt: (beltId: string) => void;
}

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

function NativeEntitySummary({
  entity,
  configuration,
  pending,
  onEntityLockChange,
  onRemoveEntity,
  onStackCountChange,
  onPowerPriorityChange,
  onSplitterDistributionModeChange,
  onEnergyExchangerModeChange,
  onFuelItemChange,
  onBlackHolePausedChange,
}: {
  entity: SelectedEntityReadModel;
  configuration: NativeProjectedEntityConfigurationBinding | null;
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
  pending,
  onEntityLockChange,
  onRemoveEntity,
  onStackCountChange,
  onEntityPowerPriorityChange,
  onSplitterDistributionModeChange,
  onEnergyExchangerModeChange,
  onFuelItemChange,
  onBlackHolePausedChange,
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
      pending={pending}
      onEntityLockChange={onEntityLockChange}
      onRemoveEntity={onRemoveEntity}
      onStackCountChange={onStackCountChange}
      onPowerPriorityChange={onEntityPowerPriorityChange}
      onSplitterDistributionModeChange={onSplitterDistributionModeChange}
      onEnergyExchangerModeChange={onEnergyExchangerModeChange}
      onFuelItemChange={onFuelItemChange}
      onBlackHolePausedChange={onBlackHolePausedChange}
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
