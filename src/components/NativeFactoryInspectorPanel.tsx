import { CircuitBoard, Layers3, LockKeyhole, Minus, Plus, Route, Trash2 } from "lucide-react";
import { CONSTRUCTION, ITEMS } from "../game/content";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  ItemQuantityReadModel,
  SelectedBeltReadModel,
  SelectedEntityReadModel,
} from "../game/factoryReadModels";
import { QuantityValue } from "./QuantityValue";

interface NativeFactoryInspectorPanelProps {
  inspector: FactoryInspectorSummaryReadModel;
  multiSelection: FactoryMultiSelectionSummaryReadModel;
  pending: boolean;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveEntity: (entityId: string) => void;
  onStackCountChange: (entityId: string, targetCount: number) => void;
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

function NativeEntitySummary({ entity, pending, onEntityLockChange, onRemoveEntity, onStackCountChange }: {
  entity: SelectedEntityReadModel;
  pending: boolean;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveEntity: (entityId: string) => void;
  onStackCountChange: (entityId: string, targetCount: number) => void;
}) {
  const label = entity.buildingId
    ? constructionNames.get(entity.buildingId) ?? entity.buildingId
    : entity.resourceId ? itemLabel(entity.resourceId) : entity.entityId;
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
  pending,
  onEntityLockChange,
  onRemoveEntity,
  onStackCountChange,
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
    content = <NativeEntitySummary entity={inspector.entity} pending={pending} onEntityLockChange={onEntityLockChange} onRemoveEntity={onRemoveEntity} onStackCountChange={onStackCountChange} />;
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
