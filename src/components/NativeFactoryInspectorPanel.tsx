import { CircuitBoard, Layers3, LockKeyhole, Route, Trash2 } from "lucide-react";
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
  onRemoveEntity: (entityId: string) => void;
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

function NativeEntitySummary({ entity, pending, onRemoveEntity }: {
  entity: SelectedEntityReadModel;
  pending: boolean;
  onRemoveEntity: (entityId: string) => void;
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

function NativeBeltSummary({ belt }: { belt: SelectedBeltReadModel }) {
  return <section className="inspector-content native-factory-inspector__belt" aria-label="Windows 原生传送带摘要">
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
  </section>;
}

/** A truly thin inspector: no full-state prop and no legacy fallback. */
export function NativeFactoryInspectorPanel({
  inspector,
  multiSelection,
  pending,
  onRemoveEntity,
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
    content = <NativeEntitySummary entity={inspector.entity} pending={pending} onRemoveEntity={onRemoveEntity} />;
  } else if (inspector.belt && !inspector.entity) {
    content = <NativeBeltSummary belt={inspector.belt} />;
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
