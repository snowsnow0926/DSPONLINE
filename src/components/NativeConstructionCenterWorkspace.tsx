import { Factory, Layers3, PackageOpen, Power, Search, Truck, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  BoundedReadModelRows,
  NativeConstructionCenterCategoryReadModel,
  NativeConstructionCenterTargetReadModel,
} from "../game/factoryReadModels";
import type { NativeConstructionCenterWorkspaceFrame } from "../game/nativeConstructionCenterWorkspace";
import { StableTextInput } from "./CompositionSafeInput";
import { QuantityValue } from "./QuantityValue";
import { WorkspaceFrame } from "./WorkspaceFrame";

type Category = "all" | NativeConstructionCenterCategoryReadModel;
export type NativeConstructionCenterReadStatus = "loading" | "ready" | "unavailable";

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  all: "全部",
  power: "能源",
  production: "生产",
  logistics: "物流",
  dyson: "戴森",
};

function TargetIcon({ target }: { target: NativeConstructionCenterTargetReadModel }) {
  if (target.kind === "fleet" || target.category === "logistics") return <Truck size={16} />;
  if (target.category === "power") return <Power size={16} />;
  if (target.targetId.startsWith("conveyor_belt_")) return <Layers3 size={16} />;
  return <Factory size={16} />;
}

function BoundedSummary<Row>({ label, rows }: { label: string; rows: BoundedReadModelRows<Row> }) {
  return <small>{label} {rows.rows.length}/{rows.totalCount}{rows.truncated ? "（投影已截断）" : ""}</small>;
}

function statusLabel(status: "game-paused" | "automation-paused" | "working" | "idle") {
  return {
    "game-paused": "游戏暂停",
    "automation-paused": "制造协议暂停",
    working: "制造中",
    idle: "空闲",
  }[status];
}

export function NativeConstructionCenterWorkspace({ open, frame, readStatus, onClose }: {
  open: boolean;
  frame: NativeConstructionCenterWorkspaceFrame | null;
  readStatus: NativeConstructionCenterReadStatus;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const workspace = frame?.workspace ?? null;
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const targets = useMemo(() => workspace?.targets.rows.filter((target) => {
    if (category !== "all" && target.category !== category) return false;
    if (!term) return true;
    const costs = target.costs.rows.map((cost) => `${cost.name} ${cost.itemId}`).join(" ");
    return `${target.name} ${target.targetId} ${target.requiredTechName ?? ""} ${costs}`
      .toLocaleLowerCase("zh-CN")
      .includes(term);
  }) ?? [], [category, term, workspace]);

  if (!open) return null;
  if (!workspace || !frame) {
    return <WorkspaceFrame className="construction-center-workspace" ariaLabel="建筑制造中心" onRequestClose={onClose}>
      <header className="construction-center-header">
        <div><i><Factory size={20} /></i><span><small>Windows 原生只读工作区</small><strong>建筑制造中心</strong></span></div>
        <button type="button" onClick={onClose} title="关闭建筑制造中心" aria-label="关闭建筑制造中心"><X size={18} /></button>
      </header>
      <div className="construction-center-status" role="status">
        <span><PackageOpen size={14} /><strong>{readStatus === "unavailable" ? "目录不受支持，已安全关闭展示" : "等待同版本原生投影"}</strong></span>
        <em>{readStatus === "unavailable" ? "仅内置目录可用；MOD、未知目录或身份漂移不会回退读取旧渲染器状态。" : "正在绑定同一 session / run / revision / active planet。"}</em>
        <em>原生写入尚未开放</em>
      </div>
    </WorkspaceFrame>;
  }

  const completedTargets = workspace.targets.rows.filter((target) => target.target > 0 && target.currentStock >= target.target).length;
  const activeTargets = workspace.targets.rows.filter((target) => target.target > 0).length;
  return <WorkspaceFrame className="construction-center-workspace" ariaLabel="建筑制造中心" onRequestClose={onClose}>
    <header
      className="construction-center-header"
      data-native-authority-session={frame.sessionId}
      data-native-authority-run={frame.runId}
      data-native-authority-revision={frame.revision}
      data-native-authority-planet={frame.activePlanetId}
    >
      <div><i><Factory size={20} /></i><span><small>Windows 原生只读工作区</small><strong>建筑制造中心</strong></span></div>
      <dl>
        <div><dt>制造中心</dt><dd><QuantityValue value={workspace.centers.totalCount} /></dd></div>
        <div><dt>补货目标</dt><dd>{completedTargets}/{activeTargets}</dd></div>
        <div><dt>制造周期</dt><dd>{workspace.cycleSeconds}s</dd></div>
        <div><dt>材料加工</dt><dd>{workspace.materialSeconds.toFixed(2)}s/件</dd></div>
        <div><dt>库存上限</dt><dd><QuantityValue value={workspace.stockLimit} /></dd></div>
      </dl>
      <button type="button" onClick={onClose} title="关闭建筑制造中心" aria-label="关闭建筑制造中心"><X size={18} /></button>
    </header>

    <div className="construction-center-toolbar">
      <label className="construction-center-toggle" title="原生写入尚未开放">
        <input type="checkbox" checked={workspace.enabled} disabled readOnly />
        <i /><span><strong>自动补足</strong><small>{workspace.enabled ? "制造协议运行（只读）" : "制造协议暂停（只读）"}</small></span>
      </label>
      <label className="construction-center-toggle" title="原生写入尚未开放">
        <input type="checkbox" checked={workspace.quantumSourceEnabled} disabled readOnly />
        <i /><span><strong>量子仓库直供</strong><small>{workspace.quantumNetworkEnabled ? workspace.quantumSourceEnabled ? "已启用（只读）" : "未启用（只读）" : "量子网络未启用"}</small></span>
      </label>
      <label className="construction-center-search"><Search size={14} /><StableTextInput draftId="native-construction-center-search" value={query} onValueChange={setQuery} placeholder="搜索建筑、科技或材料" aria-label="搜索原生自动制造目标" /></label>
      <div className="construction-center-categories" role="group" aria-label="建筑制造分类">
        {(Object.keys(CATEGORY_LABELS) as Category[]).map((id) => <button className={category === id ? "active" : ""} type="button" key={id} onClick={() => setCategory(id)}>{CATEGORY_LABELS[id]}</button>)}
      </div>
    </div>

    <section className="construction-center-batch-target" aria-label="原生建筑制造写入状态">
      <div><strong>原生写入尚未开放</strong><small>本窗口只展示 Rust 已验证的内置目录和当前状态；不会移动材料、取消任务、退款或批量改写目标。</small></div>
      <div className="construction-center-batch-target__actions">
        {[100, 1_000, 10_000].map((value) => <button type="button" key={value} disabled title="原生写入尚未开放"><QuantityValue value={value} /></button>)}
        <input value="" disabled readOnly placeholder="自定义" aria-label="全部建筑目标数量（原生写入尚未开放）" />
        <button type="button" className="primary" disabled title="原生写入尚未开放">应用全部</button>
      </div>
    </section>

    <div className="construction-center-status">
      <span><PackageOpen size={14} />取料行星 <strong>{workspace.activePlanetName}</strong></span>
      <span>累计制造 <strong><QuantityValue value={workspace.totalCrafted} /></strong></span>
      <span>最近完成 <strong>{workspace.lastCraftedName ?? "尚无"}</strong></span>
      <span>行星材料 <strong><QuantityValue value={workspace.materials.totalAmount} /></strong> <BoundedSummary label="行" rows={workspace.materials} /></span>
      <span>量子缓存 <strong><QuantityValue value={workspace.quantumBuffer.totalAmount} /></strong> <BoundedSummary label="行" rows={workspace.quantumBuffer} /></span>
      <span>销毁副产物 <strong><QuantityValue value={workspace.destroyedByproducts.totalAmount} /></strong> <BoundedSummary label="行" rows={workspace.destroyedByproducts} /></span>
      {workspace.centers.rows.map((center) => <span key={center.entityId}>{center.planetName} · {center.entityId} <strong>{statusLabel(center.status)}</strong> · ×<QuantityValue value={center.machineCount} /></span>)}
      <BoundedSummary label="中心" rows={workspace.centers} />
      <BoundedSummary label="任务" rows={workspace.jobs} />
      {workspace.centers.totalCount === 0 ? <em>当前行星尚未放置建筑制造中心</em> : null}
    </div>

    <div className="construction-center-list">
      {targets.map((target) => {
        const complete = target.target > 0 && target.currentStock >= target.target;
        return <article data-native-construction-target-id={target.targetId} className={`${target.target > 0 ? "construction-center-row construction-center-row--targeted" : "construction-center-row"}${complete ? " construction-center-row--complete" : ""}`} key={target.targetId}>
          <i><TargetIcon target={target} /></i>
          <div className="construction-center-identity">
            <strong>{target.name}</strong>
            <small>{target.unlocked ? <>每批 ×<QuantityValue value={target.outputAmount} /></> : `需要科技：${target.requiredTechName ?? target.requiredTechId ?? "未解锁"}`}</small>
          </div>
          <div className="construction-center-materials" aria-label={`${target.name}材料成本`}>
            {target.costs.rows.map((cost) => <span key={cost.itemId} title={`${cost.name} · ${cost.itemId}`}><b>{cost.name}</b> ×<QuantityValue value={cost.amount} /></span>)}
            {target.costs.truncated ? <small>成本投影 {target.costs.rows.length}/{target.costs.totalCount}</small> : null}
          </div>
          <div className="construction-center-stock">
            <small>{target.kind === "fleet" ? "随身载具" : "施工库存"}</small>
            <strong><QuantityValue value={target.currentStock} /></strong>
            <span className={complete ? "ready" : target.target > 0 ? "working" : ""}>{complete ? "已补足" : target.target > 0 ? "补货中" : "未设目标"}</span>
          </div>
          <div className="construction-center-target">
            <small>目标库存</small>
            <div className="construction-center-target__stepper">
              <button type="button" disabled title="原生写入尚未开放" aria-label={`减少${target.name}目标库存（原生写入尚未开放）`}>−</button>
              <input value={target.target} disabled readOnly aria-label={`${target.name}目标库存（只读）`} />
              <button type="button" disabled title="原生写入尚未开放" aria-label={`增加${target.name}目标库存（原生写入尚未开放）`}>＋</button>
            </div>
            <select value="readonly" disabled aria-label={`${target.name}常用目标库存（原生写入尚未开放）`}><option value="readonly">原生写入尚未开放</option></select>
          </div>
        </article>;
      })}
      {targets.length === 0 ? <div className="construction-center-empty"><PackageOpen size={22} /><strong>没有匹配的制造目标</strong><small>清除搜索词或切换分类后重试。</small></div> : null}
      <BoundedSummary label="目标" rows={workspace.targets} />
    </div>

    <section className="construction-center-status" aria-label="原生制造任务与材料明细">
      {workspace.jobs.rows.map((job) => <span key={job.entityId}><strong>{job.targetName}</strong> · {job.entityId} · 步骤 {job.stepIndex}/{job.stepCount} · {job.elapsedSeconds.toFixed(2)}s · WIP <QuantityValue value={job.inventory.totalAmount} />{job.inventory.truncated ? `（${job.inventory.rows.length}/${job.inventory.totalCount} 行）` : ""}</span>)}
      {workspace.materials.rows.map((row) => <span key={`material-${row.itemId}`}>行星材料 · <strong>{row.name}</strong> <QuantityValue value={row.amount} /></span>)}
      {workspace.quantumBuffer.rows.map((row) => <span key={`quantum-${row.entityId}-${row.itemId}`}>量子缓存 · {row.entityId} · <strong>{row.name}</strong> <QuantityValue value={row.amount} /></span>)}
      {workspace.destroyedByproducts.rows.map((row) => <span key={`destroyed-${row.itemId}`}>销毁副产物 · <strong>{row.name}</strong> <QuantityValue value={row.amount} /></span>)}
    </section>
  </WorkspaceFrame>;
}
