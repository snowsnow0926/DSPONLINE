import { Check, ClipboardList, Coins, RefreshCw, Satellite, Sparkles, Trophy, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  DesktopNativeCoreOrbitalContractRow,
  DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest,
  DesktopNativeCoreOrbitalContractWorkspaceProjectionResult,
  DesktopNativeOrbitalContractIntent,
} from "../desktop";
import { useGameDialog } from "./GameDialogProvider";
import { WorkspaceFrame } from "./WorkspaceFrame";

export interface NativeOrbitalContractWorkspaceProps {
  readonly open: boolean;
  readonly identity: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest | null;
  readonly fetchProjection: ((
    request: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest,
  ) => Promise<DesktopNativeCoreOrbitalContractWorkspaceProjectionResult>) | null;
  readonly pending?: boolean;
  readonly commandsAvailable?: boolean;
  readonly mobile?: boolean;
  readonly onClose: () => void;
  readonly onIntent: (intent: DesktopNativeOrbitalContractIntent, successNotice: string) => boolean;
}

function quantity(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function deliveryMaximum(row: DesktopNativeCoreOrbitalContractRow, itemId: string): string {
  const available = row.requirements
    .filter((entry) => entry.itemId === itemId)
    .reduce((maximum, entry) => BigInt(entry.availableQuantum) > maximum ? BigInt(entry.availableQuantum) : maximum, 0n);
  const remaining = row.requirements
    .filter((entry) => entry.itemId === itemId)
    .reduce((total, entry) => total + BigInt(entry.amount) - BigInt(entry.delivered), 0n);
  return (available < remaining ? available : remaining).toString();
}

/**
 * Native authority route: this component receives only the bounded Rust
 * contract projection and emits one semantic intent. It deliberately has no
 * GameState, legacy writer, catalog, reward formula, or inventory mutation.
 */
export function NativeOrbitalContractWorkspace({
  open,
  identity,
  fetchProjection,
  pending = false,
  commandsAvailable = true,
  mobile = false,
  onClose,
  onIntent,
}: NativeOrbitalContractWorkspaceProps) {
  const [projection, setProjection] = useState<DesktopNativeCoreOrbitalContractWorkspaceProjectionResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [reload, setReload] = useState(0);
  const [deliveryDrafts, setDeliveryDrafts] = useState<Record<string, string>>({});
  const gameDialog = useGameDialog();

  useEffect(() => {
    // A definite semantic rejection keeps the same revision. Re-read when the
    // main-owned FIFO settles so an old pre-midnight projection is replaced by
    // a fresh main-clock-fenced Rust clone without committing rollover-only
    // state as a side effect of the rejected command.
    if (pending) return;
    if (!open || !identity || !fetchProjection) {
      setProjection(null);
      setStatus("unavailable");
      return;
    }
    let active = true;
    setStatus("loading");
    void fetchProjection(identity).then((next) => {
      if (!active) return;
      if (next.sessionId !== identity.sessionId || next.runId !== identity.runId ||
          next.revision !== identity.expectedRevision ||
          next.registryFingerprint !== identity.expectedRegistryFingerprint) {
        throw new Error("native orbital-contract projection identity drifted");
      }
      setProjection(next);
      setStatus("ready");
    }).catch(() => {
      if (!active) return;
      setProjection(null);
      setStatus("unavailable");
    });
    return () => { active = false; };
  }, [fetchProjection, identity, open, pending, reload]);

  const commandEnabled = Boolean(
    projection && identity && commandsAvailable && !pending && status === "ready" &&
    projection.revision === identity.expectedRevision,
  );
  const acceptedIds = useMemo(() => new Set(projection?.accepted.map((row) => row.id) ?? []), [projection]);
  const send = (intent: DesktopNativeOrbitalContractIntent, notice: string) => {
    if (!commandEnabled) return false;
    return onIntent(intent, notice);
  };

  return <WorkspaceFrame
    open={open}
    className={`orbital-station-workspace native-orbital-contract-workspace${mobile ? " orbital-station-workspace--mobile" : ""}`}
    ariaLabel="Rust 权威轨道合同"
    onRequestClose={onClose}
    data-native-orbital-contract="workspace-v1"
    data-native-orbital-contract-status={status}
  >
    <header className="orbital-station-header">
      <div><i><Satellite size={22} /></i><span><small>Rust 权威 · GameState v47 · revision {identity?.expectedRevision ?? "—"}</small><strong>轨道空间站合同</strong></span></div>
      <dl>
        <div><dt>任务日</dt><dd>{projection?.taskDay ?? "—"}</dd></div>
        <div><dt>已完成</dt><dd>{projection?.completedContracts ?? "—"}</dd></div>
        <div><dt>轨道徽记</dt><dd><Coins size={13} />{projection ? quantity(projection.orbitalMarks) : "—"}</dd></div>
        <div><dt>声望</dt><dd><Trophy size={13} />{projection ? quantity(projection.stationReputation) : "—"}</dd></div>
      </dl>
      <button type="button" onClick={onClose} aria-label="关闭轨道合同"><X size={18} /></button>
    </header>

    <nav className="orbital-station-tabs" aria-label="原生空间站功能边界">
      <button className="active" type="button"><ClipboardList size={16} />出口合同</button>
      <button type="button" disabled>货运绑定（未接入）</button>
      <button type="button" disabled>装饰与档案（未接入）</button>
    </nav>

    <main className="orbital-station-main">
      {status === "loading" ? <section className="orbital-station-panel station-contract-panel" role="status">正在读取 Rust 合同投影…</section> : null}
      {status === "unavailable" ? <section className="orbital-station-panel station-contract-panel">
        <header className="station-section-heading"><div><small>原生权威失配时关闭操作</small><strong>合同投影暂不可用</strong></div></header>
        <p>不会回退读取 renderer GameState，也不会调用旧版合同写入函数。</p>
        <button type="button" onClick={() => setReload((value) => value + 1)}><RefreshCw size={14} />重试</button>
      </section> : null}
      {projection ? <section className="orbital-station-panel station-contract-panel">
        <header className="station-section-heading"><div><small>任务日 {projection.taskDay}</small><strong>每日出口合同</strong></div><span>{projection.accepted.length}/3 已接受</span></header>
        <div className="station-contract-grid">
          {projection.offers.map((contract) => <article className={contract.special ? "special" : ""} key={contract.id}>
            <header><span>{contract.special ? "特别合同" : contract.difficulty}</span><strong>{contract.title}</strong></header>
            <p>{contract.summary}</p>
            <ul>{contract.requirements.map((requirement, index) => <li key={`${requirement.itemId}:${index}`}><span>{requirement.itemId}</span><strong>{quantity(requirement.amount)}</strong><small>{requirement.channel === "quantum" ? "仅量子" : "量子手动交付可用"}</small></li>)}</ul>
            <footer><span><Coins size={13} />{quantity(contract.rewardMarks)}</span><span><Trophy size={13} />{quantity(contract.rewardReputation)}</span><button type="button" disabled={!commandEnabled || projection.accepted.length >= 3} onClick={() => send({ type: "accept", contractId: contract.id }, "轨道合同已由 Rust 接受")}>接受合同</button></footer>
          </article>)}
        </div>

        <section className="station-accepted-contracts"><header><strong>进行中的合同</strong><small>物资扣除、进度与奖励均由 Rust 重算</small></header>
          {projection.accepted.length ? projection.accepted.map((contract) => <article key={contract.id}>
            <header><div><span>{contract.difficulty} · 截止任务日 {contract.expiresAtTaskDay}</span><strong>{contract.title}</strong></div><b>{Math.floor(contract.completionBasisPoints / 100)}%</b></header>
            {contract.requirements.map((requirement, index) => {
              const draftKey = `${contract.id}:${requirement.itemId}`;
              const maximum = deliveryMaximum(contract, requirement.itemId);
              const draft = deliveryDrafts[draftKey] ?? maximum;
              return <div className="station-contract-requirement" key={`${requirement.itemId}:${index}`}>
                <span>{requirement.itemId}<small>{quantity(requirement.delivered)} / {quantity(requirement.amount)} · 量子可用 {quantity(requirement.availableQuantum)}</small></span>
                <i><b style={{ width: `${Math.min(100, Number(BigInt(requirement.delivered) * 100n / BigInt(requirement.amount)))}%` }} /></i>
                <input aria-label={`${requirement.itemId}量子交付数量`} inputMode="numeric" maxLength={256} value={draft} disabled={!commandEnabled || contract.status === "claimable" || maximum === "0"} onChange={(event) => setDeliveryDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} />
                <button type="button" disabled={!commandEnabled || contract.status === "claimable" || maximum === "0" || !/^[1-9][0-9]{0,255}$/.test(draft)} onClick={() => send({ type: "deliver-quantum", contractId: contract.id, itemId: requirement.itemId, requestedAmount: draft }, "合同物资已由 Rust 守恒交付")}><Sparkles size={13} />量子交付</button>
              </div>;
            })}
            <footer><button type="button" disabled={!commandEnabled || contract.status !== "claimable"} onClick={() => send({ type: "claim", contractId: contract.id }, "合同奖励已由 Rust 结算")}><Check size={14} />领取完成奖励</button><button className="danger" type="button" disabled={!commandEnabled} onClick={() => void gameDialog.confirm("放弃后由 Rust 按当前加权完成比例结算基础奖励，且无法恢复。确定继续？", { danger: true, title: "放弃出口合同", confirmLabel: "放弃并结算" }).then((confirmed) => confirmed && send({ type: "abandon", contractId: contract.id }, "合同已由 Rust 部分结算"))}>放弃并部分结算</button></footer>
          </article>) : <p>尚未接受合同。</p>}
        </section>

        <section className="station-showcase-history"><header><strong>已完成出口合同</strong><small>{projection.completedContracts} 份</small></header>{projection.completedHistory.map((contract) => <button className={projection.featuredContractId === contract.id ? "active" : ""} type="button" disabled={!commandEnabled || acceptedIds.has(contract.id)} key={contract.id} onClick={() => send({ type: "feature", contractId: projection.featuredContractId === contract.id ? null : contract.id }, "展示合同已由 Rust 更新")}><Trophy size={14} /><span>{contract.title}</span><small>{contract.difficulty}</small></button>)}</section>
      </section> : null}
    </main>
  </WorkspaceFrame>;
}
