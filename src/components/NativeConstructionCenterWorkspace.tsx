import { Factory, Layers3, Minus, PackageOpen, Plus, Power, Search, TriangleAlert, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BoundedReadModelRows,
  NativeConstructionCenterCategoryReadModel,
  NativeConstructionCenterTargetReadModel,
} from "../game/factoryReadModels";
import {
  confirmNativeConstructionCenterBatchBuildingTargetStock,
  confirmNativeConstructionCenterTargetStock,
  evaluateNativeConstructionCenterBatchBuildingTargetStock,
  evaluateNativeConstructionCenterTargetStock,
  nativeConstructionCenterFrameIdentity,
  nativeConstructionCenterIdentityKey,
  nativeConstructionCenterPendingKey,
  nativeConstructionCenterTargetPresets,
  parseNativeConstructionCenterTargetDraft,
  type NativeConstructionCenterBatchBuildingTargetStockConfirmation,
  type NativeConstructionCenterBatchBuildingTargetStockSubmission,
  type NativeConstructionCenterFrameIdentity,
  type NativeConstructionCenterPendingIdentity,
  type NativeConstructionCenterTargetStockConfirmation,
  type NativeConstructionCenterTargetStockSubmission,
} from "../game/nativeConstructionCenterIntent";
import type { NativeConstructionCenterWorkspaceFrame } from "../game/nativeConstructionCenterWorkspace";
import { formatQuantityCompact } from "../game/quantityFormat";
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

function NativeConstructionTargetControl({ target, stockLimit, frameKey, locked, onInteraction, onRequest }: {
  target: NativeConstructionCenterTargetReadModel;
  stockLimit: number;
  frameKey: string;
  locked: boolean;
  onInteraction: () => void;
  onRequest: (target: number) => void;
}) {
  const [draft, setDraft] = useState(String(target.target));
  const [error, setError] = useState<string | null>(null);
  const skipNextBlurRef = useRef(false);
  const step = Math.max(1, target.outputAmount);
  const presets = nativeConstructionCenterTargetPresets(stockLimit);
  const disabled = locked || !target.unlocked;

  useEffect(() => {
    skipNextBlurRef.current = false;
    setDraft(String(target.target));
    setError(null);
  }, [disabled, frameKey, stockLimit, target.target, target.targetId]);

  const request = (value: number): "same" | "requested" => {
    setDraft(String(target.target));
    setError(null);
    if (value === target.target) return "same";
    skipNextBlurRef.current = false;
    onInteraction();
    onRequest(value);
    return "requested";
  };
  const commitDraft = (): "invalid" | "same" | "requested" => {
    const parsed = parseNativeConstructionCenterTargetDraft(draft, stockLimit);
    if (!parsed.ok) {
      setError(parsed.message);
      return "invalid";
    }
    return request(parsed.value);
  };

  return <div className="construction-center-target">
    <small>目标库存</small>
    <div className="construction-center-target__stepper">
      <button
        type="button"
        disabled={disabled || target.target <= 0}
        onClick={() => request(Math.max(0, target.target - step))}
        aria-label={`减少${target.name}目标库存`}
      ><Minus size={13} /></button>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        min={0}
        max={stockLimit}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          skipNextBlurRef.current = false;
          onInteraction();
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={() => {
          if (skipNextBlurRef.current) {
            skipNextBlurRef.current = false;
            return;
          }
          commitDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const result = commitDraft();
            if (result === "requested") skipNextBlurRef.current = true;
            if (result !== "invalid") event.currentTarget.blur();
          } else if (event.key === "Escape") {
            skipNextBlurRef.current = false;
            onInteraction();
            setDraft(String(target.target));
            setError(null);
          }
        }}
        aria-label={`${target.name}目标库存`}
        aria-invalid={Boolean(error)}
      />
      <button
        type="button"
        disabled={disabled || target.target >= stockLimit}
        onClick={() => request(Math.min(stockLimit, target.target + step))}
        aria-label={`增加${target.name}目标库存`}
      ><Plus size={13} /></button>
    </div>
    <select
      value={presets.includes(target.target) ? String(target.target) : ""}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value !== "") request(Number(event.target.value));
      }}
      aria-label={`${target.name}常用目标库存`}
    >
      {!presets.includes(target.target) ? <option value="">自定义 {target.target.toLocaleString("zh-CN")}</option> : null}
      {presets.map((value) => <option value={value} key={value}>{value === 0
        ? "关闭自动补足"
        : value === stockLimit ? `最大 ${formatQuantityCompact(value)}` : formatQuantityCompact(value)}</option>)}
    </select>
    {error ? <em role="alert">{error}</em> : null}
  </div>;
}

export function NativeConstructionCenterWorkspace({
  open,
  frame,
  readStatus,
  pendingIdentity,
  onClose,
  onSubmitEnabledIntent,
  onSubmitQuantumSupplyIntent,
  onSubmitBatchBuildingTargetStockIntent,
  onSubmitTargetStockIntent,
}: {
  open: boolean;
  frame: NativeConstructionCenterWorkspaceFrame | null;
  readStatus: NativeConstructionCenterReadStatus;
  pendingIdentity: NativeConstructionCenterPendingIdentity | null;
  onClose: () => void;
  onSubmitEnabledIntent: (identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void;
  onSubmitQuantumSupplyIntent: (identity: NativeConstructionCenterFrameIdentity, enabled: boolean) => void;
  onSubmitBatchBuildingTargetStockIntent: (submission: NativeConstructionCenterBatchBuildingTargetStockSubmission) => void;
  onSubmitTargetStockIntent: (submission: NativeConstructionCenterTargetStockSubmission) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [confirmation, setConfirmation] = useState<NativeConstructionCenterTargetStockConfirmation | null>(null);
  const [batchDraft, setBatchDraft] = useState("100");
  const [batchConfirmation, setBatchConfirmation] = useState<NativeConstructionCenterBatchBuildingTargetStockConfirmation | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const workspace = frame?.workspace ?? null;
  const term = query.trim().toLocaleLowerCase("zh-CN");
  const frameIdentity = frame ? nativeConstructionCenterFrameIdentity(frame) : null;
  const frameIdentityKey = nativeConstructionCenterIdentityKey(frameIdentity);
  const pendingKey = nativeConstructionCenterPendingKey(pendingIdentity);
  const writeLocked = pendingIdentity !== null || workspace?.writeAvailable !== true;
  const targets = useMemo(() => workspace?.targets.rows.filter((target) => {
    if (category !== "all" && target.category !== category) return false;
    if (!term) return true;
    const costs = target.costs.rows.map((cost) => `${cost.name} ${cost.itemId}`).join(" ");
    return `${target.name} ${target.targetId} ${target.requiredTechName ?? ""} ${costs}`
      .toLocaleLowerCase("zh-CN")
      .includes(term);
  }) ?? [], [category, term, workspace]);

  useEffect(() => {
    setConfirmation(null);
    setBatchConfirmation(null);
    setInteractionError(null);
  }, [category, frameIdentityKey, open, pendingKey, query]);

  useEffect(() => {
    const stockLimit = workspace?.stockLimit;
    setBatchDraft(String(typeof stockLimit === "number" && Number.isSafeInteger(stockLimit) && stockLimit > 0
      ? Math.min(100, stockLimit)
      : 100));
  }, [frameIdentityKey, open, pendingKey, workspace?.stockLimit]);

  if (!open) return null;
  if (!workspace || !frame || !frameIdentity) {
    return <WorkspaceFrame className="construction-center-workspace" ariaLabel="建筑制造中心" onRequestClose={onClose}>
      <header className="construction-center-header">
        <div><i><Factory size={20} /></i><span><small>Windows 原生权威工作区</small><strong>建筑制造中心</strong></span></div>
        <button type="button" onClick={onClose} title="关闭建筑制造中心" aria-label="关闭建筑制造中心"><X size={18} /></button>
      </header>
      <div className="construction-center-status" role="status">
        <span><PackageOpen size={14} /><strong>{readStatus === "unavailable" ? "目录不受支持，已安全关闭展示与写入" : "等待同版本原生投影"}</strong></span>
        <em>{readStatus === "unavailable" ? "仅内置目录可用；MOD、未知目录或身份漂移不会回退读取或写入旧渲染器状态。" : "正在绑定同一 session / run / revision / active planet。"}</em>
      </div>
    </WorkspaceFrame>;
  }

  const requestTargetStock = (targetId: string, value: number) => {
    setConfirmation(null);
    setBatchConfirmation(null);
    setInteractionError(null);
    const evaluated = evaluateNativeConstructionCenterTargetStock(frame, pendingIdentity, targetId, value);
    if (evaluated.status === "rejected") {
      setInteractionError(evaluated.message);
    } else if (evaluated.status === "confirmation-required") {
      setConfirmation(evaluated.confirmation);
    } else {
      onSubmitTargetStockIntent(evaluated.submission);
    }
  };
  const confirmTargetDecrease = () => {
    if (!confirmation) return;
    const submission = confirmNativeConstructionCenterTargetStock(frame, pendingIdentity, confirmation);
    setConfirmation(null);
    if (!submission) {
      setInteractionError("确认已因投影、选择或命令状态变化而失效；存档未改变");
      return;
    }
    onSubmitTargetStockIntent(submission);
  };
  const requestBatchBuildingTargetStock = (value: number) => {
    setConfirmation(null);
    setBatchConfirmation(null);
    setInteractionError(null);
    const evaluated = evaluateNativeConstructionCenterBatchBuildingTargetStock(frame, pendingIdentity, value);
    if (evaluated.status === "rejected") {
      setInteractionError(evaluated.message);
    } else {
      setBatchConfirmation(evaluated.confirmation);
    }
  };
  const commitBatchDraft = () => {
    const parsed = parseNativeConstructionCenterTargetDraft(batchDraft, workspace.stockLimit);
    if (!parsed.ok) {
      setInteractionError(parsed.message);
      return;
    }
    if (parsed.value < 1) {
      setInteractionError("全部建筑目标必须是正安全整数");
      return;
    }
    requestBatchBuildingTargetStock(parsed.value);
  };
  const confirmBatchBuildingTargetStock = () => {
    if (!batchConfirmation) return;
    const submission = confirmNativeConstructionCenterBatchBuildingTargetStock(frame, pendingIdentity, batchConfirmation);
    setBatchConfirmation(null);
    if (!submission) {
      setInteractionError("批量确认已因投影、目录或命令状态变化而失效；存档未改变");
      return;
    }
    onSubmitBatchBuildingTargetStockIntent(submission);
  };
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
      <div><i><Factory size={20} /></i><span><small>Windows 原生权威工作区</small><strong>建筑制造中心</strong></span></div>
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
      <label className="construction-center-toggle" title={writeLocked ? "等待原生命令与新 revision 投影" : undefined}>
        <input type="checkbox" checked={workspace.enabled} disabled={writeLocked} onChange={(event) => {
          setConfirmation(null);
          setBatchConfirmation(null);
          onSubmitEnabledIntent(frameIdentity, event.target.checked);
        }} />
        <i /><span><strong>自动补足</strong><small>{workspace.enabled ? "制造协议运行" : "制造协议暂停"}</small></span>
      </label>
      <label className="construction-center-toggle" title={writeLocked ? "等待原生命令与新 revision 投影" : undefined}>
        <input type="checkbox" checked={workspace.quantumSourceEnabled} disabled={writeLocked || !workspace.quantumNetworkEnabled} onChange={(event) => {
          setConfirmation(null);
          setBatchConfirmation(null);
          onSubmitQuantumSupplyIntent(frameIdentity, event.target.checked);
        }} />
        <i /><span><strong>量子仓库直供</strong><small>{!workspace.quantumNetworkEnabled
          ? "需先启用量子网络"
          : workspace.quantumSourceEnabled ? "已启用；等待 Rust 五秒边界直供" : "仅使用行星托盘"}</small></span>
      </label>
      <label className="construction-center-search"><Search size={14} /><StableTextInput
        draftId="native-construction-center-search"
        value={query}
        onValueChange={(value) => {
          setConfirmation(null);
          setBatchConfirmation(null);
          setQuery(value);
        }}
        placeholder="搜索建筑、科技或材料"
        aria-label="搜索原生自动制造目标"
      /></label>
      <div className="construction-center-categories" role="group" aria-label="建筑制造分类">
        {(Object.keys(CATEGORY_LABELS) as Category[]).map((id) => <button className={category === id ? "active" : ""} type="button" key={id} onClick={() => {
          setConfirmation(null);
          setBatchConfirmation(null);
          setCategory(id);
        }}>{CATEGORY_LABELS[id]}</button>)}
      </div>
    </div>

    <section className="construction-center-batch-target" aria-label="原生建筑制造批量写入">
      <div><strong>全部已解锁建筑目标</strong><small>一条原子 Rust 意图统一修改；只改补货策略，不循环命令、不取消任务或退料。</small></div>
      <div className="construction-center-batch-target__actions">
        {[100, 1_000, 10_000].map((value) => <button
          type="button"
          key={value}
          disabled={writeLocked || value > workspace.stockLimit}
          onClick={() => {
            setBatchDraft(String(value));
            requestBatchBuildingTargetStock(value);
          }}
        ><QuantityValue value={value} /></button>)}
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          min={1}
          max={workspace.stockLimit}
          value={batchDraft}
          disabled={writeLocked}
          onChange={(event) => {
            setBatchConfirmation(null);
            setBatchDraft(event.target.value);
            setInteractionError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitBatchDraft();
            }
          }}
          placeholder="自定义"
          aria-label="全部已解锁建筑目标数量"
        />
        <button type="button" className="primary" disabled={writeLocked} onClick={commitBatchDraft}>应用全部</button>
      </div>
    </section>

    {pendingIdentity ? <div className="construction-center-status" role="status" data-native-construction-pending-kind={pendingIdentity.kind}>
      <span><strong>{pendingIdentity.kind === "otherNativeCommand" ? "其他原生命令确认中" : "建筑制造命令确认中"}</strong></span>
      <em>{pendingIdentity.expectedRevision === null
        ? "等待 main-owned durable ACK；界面不会乐观改写。"
        : `耐久 ACK 已确认，等待 revision ${pendingIdentity.expectedRevision.toLocaleString("zh-CN")} 或更新的同身份 Rust 投影。`}</em>
    </div> : null}

    {!workspace.writeAvailable ? <div className="construction-center-status" role="status">
      <span><TriangleAlert size={14} /><strong>Rust 尚未证明制造协议科技与可用制造中心</strong></span>
      <em>需要完成制造协议科技，且任一行星存在未锁定、数量有效的建筑制造中心；四类原生写入均已安全锁定。</em>
    </div> : null}

    {batchConfirmation ? <section
      className="construction-center-batch-target construction-center-native-confirm"
      role="alertdialog"
      aria-label="确认批量设置全部已解锁建筑目标"
      data-native-construction-confirm-batch-target={batchConfirmation.target}
    >
      <div><strong><TriangleAlert size={14} />确认统一设置全部已解锁建筑目标</strong><small>
        将检查 {batchConfirmation.affectedCount.toLocaleString("zh-CN")} 种建筑，把其中 {batchConfirmation.changedCount.toLocaleString("zh-CN")} 种改为 {batchConfirmation.target.toLocaleString("zh-CN")}
        {batchConfirmation.loweredCount > 0 ? `，其中 ${batchConfirmation.loweredCount.toLocaleString("zh-CN")} 种会降低目标` : ""}。
        只改变后续补货策略；不会取消或退款现有任务，也不会改写 WIP、托盘、量子库存或随身库存。
      </small></div>
      <div className="construction-center-batch-target__actions">
        <button type="button" onClick={() => setBatchConfirmation(null)}>取消</button>
        <button type="button" className="primary" onClick={confirmBatchBuildingTargetStock}>确认并提交单条 Rust 意图</button>
      </div>
    </section> : null}

    {confirmation ? <section
      className="construction-center-batch-target construction-center-native-confirm"
      role="alertdialog"
      aria-label={`确认降低${confirmation.targetName}目标库存`}
      data-native-construction-confirm-target={confirmation.targetId}
    >
      <div><strong><TriangleAlert size={14} />确认降低 {confirmation.targetName} 的目标</strong><small>
        {confirmation.previousTarget.toLocaleString("zh-CN")} → {confirmation.target.toLocaleString("zh-CN")}。
        {confirmation.cancelsJobsAndRefunds
          ? ` 新目标不高于当前库存 ${confirmation.currentStock.toLocaleString("zh-CN")}，Rust 会取消同目标在途任务并按守恒规则退款。`
          : " 降低目标可能改变后续补货与在途任务，必须显式确认。"}
      </small></div>
      <div className="construction-center-batch-target__actions">
        <button type="button" onClick={() => setConfirmation(null)}>取消</button>
        <button type="button" className="primary" onClick={confirmTargetDecrease}>确认降低并提交 Rust</button>
      </div>
    </section> : null}
    {interactionError ? <div className="construction-center-status"><em role="alert">{interactionError}</em></div> : null}

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
          <div className="construction-center-identity"><strong>{target.name}</strong><small>{target.unlocked ? <>每批 ×<QuantityValue value={target.outputAmount} /></> : `需要科技：${target.requiredTechName ?? target.requiredTechId ?? "未解锁"}`}</small></div>
          <div className="construction-center-materials" aria-label={`${target.name}材料成本`}>
            {target.costs.rows.map((cost) => <span key={cost.itemId} title={`${cost.name} · ${cost.itemId}`}><b>{cost.name}</b> ×<QuantityValue value={cost.amount} /></span>)}
            {target.costs.truncated ? <small>成本投影 {target.costs.rows.length}/{target.costs.totalCount}</small> : null}
          </div>
          <div className="construction-center-stock">
            <small>{target.kind === "fleet" ? "随身载具" : "施工库存"}</small>
            <strong><QuantityValue value={target.currentStock} /></strong>
            <span className={complete ? "ready" : target.target > 0 ? "working" : ""}>{complete ? "已补足" : target.target > 0 ? "补货中" : "未设目标"}</span>
          </div>
          <NativeConstructionTargetControl
            target={target}
            stockLimit={workspace.stockLimit}
            frameKey={frameIdentityKey}
            locked={writeLocked}
            onInteraction={() => {
              setConfirmation(null);
              setBatchConfirmation(null);
            }}
            onRequest={(value) => requestTargetStock(target.targetId, value)}
          />
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
