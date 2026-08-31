import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Factory,
  Gauge,
  PackageOpen,
  Power,
  RefreshCw,
  Route,
  ShieldCheck,
  Ship,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  NativeSystemSpaceStationPage,
  NativeSystemSpaceStationPageLane,
  NativeSystemSpaceStationWorkspaceFetchProjection,
  NativeSystemSpaceStationWorkspaceIdentity,
} from "../game/nativeSystemSpaceStationWorkspaceStore";
import { useNativeSystemSpaceStationWorkspace } from "../hooks/useNativeSystemSpaceStationWorkspace";
import { WorkspaceFrame } from "./WorkspaceFrame";

export interface NativeSystemSpaceStationWorkspaceProps {
  readonly open: boolean;
  readonly identity: NativeSystemSpaceStationWorkspaceIdentity | null;
  readonly fetchProjection: NativeSystemSpaceStationWorkspaceFetchProjection | null;
  readonly mobile?: boolean;
  readonly pending?: boolean;
  readonly onClose: () => void;
  readonly onStartConstruction?: (systemId: string) => boolean | void;
  readonly onDeliverMaterial?: (systemId: string, planetId: string, itemId: string, amount: number) => boolean | void;
  readonly onSetModuleCount?: (
    systemId: string,
    module: "backbone" | "energy" | "interstellar",
    target: number,
  ) => boolean | void;
  readonly onUpgradeStation?: (entityId: string) => boolean | void;
  readonly onUpgradeAllStations?: (systemId: string) => boolean | void;
  readonly onRequestMode?: (entityId: string, mode: "legacy" | "elevator") => boolean | void;
  readonly onSetOutput?: (entityId: string, portIndex: number, itemId: string | null) => boolean | void;
}

function quantity(value: string | number): string {
  const text = typeof value === "number" ? String(Math.max(0, Math.floor(value))) : value;
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function stationStatusLabel(status: "not-started" | "building" | "operational"): string {
  return status === "operational" ? "已运行" : status === "building" ? "施工中" : "未开工";
}

function modeLabel(mode: "legacy" | "elevator"): string {
  return mode === "elevator" ? "太空电梯" : "传统物流";
}

function transitionLabel(transition: "to-elevator" | "to-legacy" | null): string {
  return transition === "to-elevator" ? "正在切换到太空电梯" :
    transition === "to-legacy" ? "正在切换到传统物流" : "模式稳定";
}

function NativeSystemStationPageControls<Row>({
  lane,
  label,
  page,
  disabled,
  onCursorChange,
}: {
  readonly lane: NativeSystemSpaceStationPageLane;
  readonly label: string;
  readonly page: NativeSystemSpaceStationPage<Row>;
  readonly disabled: boolean;
  readonly onCursorChange: (lane: NativeSystemSpaceStationPageLane, cursor: number) => void;
}) {
  const first = page.rows.length > 0 ? page.cursor + 1 : 0;
  const last = page.cursor + page.rows.length;
  const previous = Math.max(0, page.cursor - page.limit);
  return <nav
    aria-label={`${label}分页`}
    data-native-system-station-pagination={lane}
    style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}
  >
    <span style={{ color: "var(--muted, #9db2aa)", fontSize: 11 }}>{first}–{last} / {page.totalCount}</span>
    <button
      type="button"
      aria-label={`${label}上一页`}
      disabled={disabled || page.cursor === 0}
      onClick={() => onCursorChange(lane, previous)}
      data-native-system-station-page={`${lane}:previous`}
    ><ChevronLeft size={14} /></button>
    <button
      type="button"
      aria-label={`${label}下一页`}
      disabled={disabled || page.nextCursor === null}
      onClick={() => { if (page.nextCursor !== null) onCursorChange(lane, page.nextCursor); }}
      data-native-system-station-page={`${lane}:next`}
    ><ChevronRight size={14} /></button>
  </nav>;
}

function EmptyPage({ children }: { readonly children: string }) {
  return <p data-native-system-station-empty style={{ color: "var(--muted, #9db2aa)", margin: 0 }}>{children}</p>;
}

function NativeSystemStationOutputControl({
  entityId,
  portIndex,
  itemId,
  itemName,
  disabled,
  onSetOutput,
}: {
  readonly entityId: string;
  readonly portIndex: number;
  readonly itemId: string | null;
  readonly itemName: string;
  readonly disabled: boolean;
  readonly onSetOutput?: (entityId: string, portIndex: number, itemId: string | null) => boolean | void;
}) {
  const [draft, setDraft] = useState(itemId ?? "");
  const [armedValue, setArmedValue] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setDraft(itemId ?? "");
    setArmedValue(undefined);
  }, [entityId, itemId, portIndex]);
  const normalized = draft.trim() || null;
  const unchanged = normalized === itemId;
  const armed = armedValue !== undefined && armedValue === normalized;
  const submit = () => {
    if (disabled || unchanged || !onSetOutput) return;
    if (!armed) {
      setArmedValue(normalized);
      return;
    }
    const accepted = onSetOutput(entityId, portIndex, normalized);
    if (accepted !== false) setArmedValue(undefined);
  };
  return <label data-native-system-station-output={portIndex}>
    <span>输出 {portIndex + 1}</span>
    <input
      aria-label={`输出 ${portIndex + 1} 物料 ID`}
      value={draft}
      placeholder={itemName || "留空即清除"}
      disabled={disabled || !onSetOutput}
      onChange={(event) => {
        setDraft(event.target.value);
        setArmedValue(undefined);
      }}
    />
    <button
      type="button"
      disabled={disabled || !onSetOutput || unchanged}
      onClick={submit}
      data-native-system-station-output-submit={portIndex}
    >{armed ? "再次确认" : normalized ? "设置" : "清除"}</button>
  </label>;
}

/**
 * The Windows authority workspace consumes only the bounded Rust projection.
 * It has no GameState prop, catalog import, simulation command, or legacy
 * fallback, so opening the panel cannot duplicate the player's full save.
 */
export function NativeSystemSpaceStationWorkspace({
  open,
  identity,
  fetchProjection,
  mobile = false,
  pending = false,
  onClose,
  onStartConstruction,
  onDeliverMaterial,
  onSetModuleCount,
  onUpgradeStation,
  onUpgradeAllStations,
  onRequestMode,
  onSetOutput,
}: NativeSystemSpaceStationWorkspaceProps) {
  const workspace = useNativeSystemSpaceStationWorkspace({ open, identity, fetchProjection });
  const { snapshot, frame } = workspace;
  const projection = frame?.projection ?? null;
  const handleClose = () => {
    workspace.close();
    onClose();
  };
  const title = projection?.system.displayName ?? identity?.systemId ?? "系统空间站";
  const loading = snapshot.status === "loading";
  const unavailable = snapshot.status === "unavailable" || !identity || !fetchProjection ||
    snapshot.status === "empty" && open;
  const commandsEnabled = Boolean(projection && identity && frame &&
    frame.sessionId === identity.sessionId && frame.runId === identity.runId &&
    frame.revision === identity.revision && !loading && !pending);

  return <WorkspaceFrame
    open={open}
    className={`system-space-station-workspace native-system-space-station-workspace${mobile ? " system-space-station-workspace--mobile" : ""}`}
    ariaLabel={`${title}原生空间站`}
    onRequestClose={handleClose}
    data-native-system-space-station="workspace-v1"
    data-native-system-space-station-status={snapshot.status}
  >
    <header className="system-space-station-header">
      <div className="system-space-station-title">
        <i><Sparkles size={20} /></i>
        <span><small>Rust 权威 · 有界投影与意图命令{identity ? ` · revision ${identity.revision}` : ""}</small><strong>{title}</strong></span>
        {projection ? <b>{stationStatusLabel(projection.station.status)}</b> : null}
      </div>
      <button type="button" className="system-space-station-close" onClick={handleClose} aria-label="关闭原生空间站"><X size={18} /></button>
    </header>

    <div className="system-space-station-scroll">
      {loading ? <section className="system-space-station-card" role="status" data-native-system-space-station-loading>
        <header><RefreshCw size={17} /><strong>正在读取 Rust 权威空间站分页</strong><span>只有同一 session、run、revision 与目录指纹的完整响应才会显示。</span></header>
      </section> : null}

      {unavailable && !loading ? <section className="system-space-station-card" role="alert" data-native-system-space-station-error>
        <header><CircleOff size={17} /><strong>原生空间站投影暂不可用</strong><span>界面已安全停在空状态，不会回退读取 JavaScript GameState 或旧缓存。</span></header>
        <div><button type="button" onClick={workspace.retry}><RefreshCw size={14} />重新读取</button></div>
      </section> : null}

      {projection ? <>
        <section className="system-space-station-overview" data-native-system-space-station-overview>
          <div className="system-space-station-overview-main">
            <span>联合施工 · 阶段 {projection.station.phaseIndex + 1}</span>
            <strong>{(projection.station.progress.basisPoints / 100).toFixed(2)}%</strong>
            <small>{quantity(projection.station.progress.deliveredAmount)} / {quantity(projection.station.progress.requiredAmount)} 材料单位</small>
            <div
              className="system-space-station-progress"
              role="progressbar"
              aria-label="空间站施工进度"
              aria-valuemin={0}
              aria-valuemax={10_000}
              aria-valuenow={projection.station.progress.basisPoints}
            ><i style={{ width: `${projection.station.progress.basisPoints / 100}%` }} /></div>
          </div>
          <div className="system-space-station-kpis">
            <span><Boxes size={15} />共享库存<strong>{quantity(projection.station.inventoryAmount)}</strong></span>
            <span><Route size={15} />星际物流站<strong>{projection.summary.interstellarStationCount}</strong></span>
            <span><Ship size={15} />舰队忙碌<strong>{projection.hubNetwork.fleetBusy} / {projection.hubNetwork.fleetInstalled}</strong></span>
            <span><Zap size={15} />翘曲器<strong>{quantity(projection.hubNetwork.warpers)}</strong></span>
          </div>
        </section>

        {projection.station.status === "not-started" ? <section className="system-space-station-card system-space-station-start" data-native-system-space-station-start>
          <Factory size={22} />
          <div><strong>空间站项目尚未开工</strong><span>{projection.station.canStartConstruction
            ? "Rust 已确认系统、科技和施工发射平台满足开工条件。"
            : `开工条件：系统${projection.system.unlocked ? "已解锁" : "未解锁"}、科技${projection.technology.constructionReady ? "已完成" : "未完成"}、发射平台${projection.station.launcherPresent ? "已存在" : "缺失"}。`}</span></div>
          <button
            type="button"
            disabled={!commandsEnabled || !projection.station.canStartConstruction || !onStartConstruction}
            onClick={() => onStartConstruction?.(projection.system.systemId)}
            data-native-system-station-command="start"
          >{pending ? "提交中…" : "开始施工"}</button>
        </section> : null}

        <section className="system-space-station-card" data-native-system-space-station-section="requirements">
          <header>
            <PackageOpen size={17} /><strong>施工材料</strong><span>只显示 Rust 计算出的本系施工账本；缓冲与已交付数量分开呈现。</span>
            <NativeSystemStationPageControls lane="requirement" label="施工材料" page={projection.requirements} disabled={loading} onCursorChange={workspace.setPageCursor} />
          </header>
          {projection.requirements.rows.length === 0 ? <EmptyPage>当前页没有施工材料。</EmptyPage> : <div className="system-space-station-requirements">
            {projection.requirements.rows.map((requirement) => <div
              className={requirement.complete ? "complete" : ""}
              key={requirement.requirementIndex}
              data-native-system-station-requirement={requirement.requirementIndex}
            >
              <span>{requirement.phaseName}{requirement.current ? " · 当前阶段" : ""}</span>
              <strong>{requirement.itemName}</strong>
              <em>{quantity(requirement.deliveredAmount)} / {quantity(requirement.requiredAmount)} · 缓冲 {quantity(requirement.constructionBufferAmount)}</em>
              {requirement.complete ? <Check size={14} aria-label="已完成" /> : null}
            </div>)}
          </div>}
        </section>

        <section className="system-space-station-card" data-native-system-space-station-section="inventory">
          <header>
            <Gauge size={17} /><strong>系统共享仓库</strong><span>库存和星际策略都来自同一 revision；本界面不会生成可写副本。</span>
            <NativeSystemStationPageControls lane="inventory" label="共享仓库" page={projection.sharedInventory} disabled={loading} onCursorChange={workspace.setPageCursor} />
          </header>
          {projection.sharedInventory.rows.length === 0 ? <EmptyPage>共享仓库当前为空。</EmptyPage> : <div className="system-space-station-inventory">
            {projection.sharedInventory.rows.map((entry) => <span key={entry.itemId} data-native-system-station-inventory={entry.itemId}>
              <b>{entry.itemName}<small style={{ display: "block" }}>{entry.policy
                ? `${entry.policy.interstellarEnabled ? "星际启用" : "仅本地"} · 保留 ${quantity(entry.policy.reserve)} · 目标 ${quantity(entry.policy.target)}`
                : "未配置策略"}</small></b>
              <strong>{quantity(entry.amount)}</strong>
            </span>)}
          </div>}
        </section>

        <section className="system-space-station-card" data-native-system-space-station-section="trays">
          <header>
            <Boxes size={17} /><strong>本系行星托盘</strong><span>共 {projection.summary.trayMaterialCount} 项，当前可用 {quantity(projection.summary.trayAvailableAmount)}；仅列出本恒星系。</span>
            <NativeSystemStationPageControls lane="tray" label="行星托盘" page={projection.trayMaterials} disabled={loading} onCursorChange={workspace.setPageCursor} />
          </header>
          {projection.trayMaterials.rows.length === 0 ? <EmptyPage>当前页没有行星托盘物料。</EmptyPage> : <div className="system-space-station-requirements">
            {projection.trayMaterials.rows.map((entry) => <div key={`${entry.planetId}:${entry.itemId}`} data-native-system-station-tray={`${entry.planetId}:${entry.itemId}`}>
              <span>{entry.planetName}{entry.activePlanet ? " · 当前行星" : ""}</span>
              <strong>{entry.itemName}</strong>
              <em>{quantity(entry.amount)}{entry.constructionMaterial ? " · 施工材料" : ""}</em>
              {entry.constructionMaterial && projection.station.status === "building" ? <button
                type="button"
                disabled={!commandsEnabled || entry.amount <= 0 || !onDeliverMaterial}
                onClick={() => onDeliverMaterial?.(
                  projection.system.systemId,
                  entry.planetId,
                  entry.itemId,
                  entry.amount,
                )}
                data-native-system-station-command="deliver"
              >交付可用物料</button> : null}
            </div>)}
          </div>}
        </section>

        <section className="system-space-station-card" data-native-system-space-station-section="modules">
          <header><Power size={17} /><strong>功能模块</strong><span>数量与可用材料由 Rust 在提交 revision 再次校验。</span></header>
          <div className="system-space-station-modules">
            {([
              ["backbone", "物流主干", projection.station.modules.backbone],
              ["energy", "能源核心", projection.station.modules.energy],
              ["interstellar", "星际运输", projection.station.modules.interstellar],
            ] as const).map(([module, label, count]) => <label key={module}>
              <span>{label}</span><strong>{count.toLocaleString("zh-CN")}</strong>
              <button
                type="button"
                aria-label={`${label}减少 1`}
                disabled={!commandsEnabled || projection.station.status !== "operational" ||
                  !projection.technology.moduleAssemblyReady || count <= 0 || !onSetModuleCount}
                onClick={() => onSetModuleCount?.(projection.system.systemId, module, count - 1)}
                data-native-system-station-command={`module-${module}-decrease`}
              >−</button>
              <button
                type="button"
                aria-label={`${label}增加 1`}
                disabled={!commandsEnabled || projection.station.status !== "operational" ||
                  !projection.technology.moduleAssemblyReady || count >= 1_000_000 || !onSetModuleCount}
                onClick={() => onSetModuleCount?.(projection.system.systemId, module, count + 1)}
                data-native-system-station-command={`module-${module}-increase`}
              >+</button>
            </label>)}
          </div>
          <small>模块装配科技：{projection.technology.moduleAssemblyReady ? "已解锁" : "未解锁"} · 自律施工：{projection.technology.autonomousConstructionReady ? "已解锁" : "未解锁"} · 多货物总线：{projection.technology.orbitalBusReady ? "已解锁" : "未解锁"}</small>
        </section>

        <section className="system-space-station-card" data-native-system-space-station-section="stations">
          <header>
            <Route size={17} /><strong>星际物流站</strong><span>Mk.I {projection.summary.mk1StationCount} · Mk.II {projection.summary.mk2StationCount} · 电梯 {projection.summary.elevatorStationCount} · 切换中 {projection.summary.transitioningStationCount}</span>
            <NativeSystemStationPageControls lane="station" label="星际物流站" page={projection.interstellarStations} disabled={loading} onCursorChange={workspace.setPageCursor} />
          </header>
          {projection.summary.mk1StationCount > 0 ? <button
            type="button"
            disabled={!commandsEnabled || !onUpgradeAllStations}
            onClick={() => onUpgradeAllStations?.(projection.system.systemId)}
            data-native-system-station-command="upgrade-all"
          >升级本系全部 Mk.I</button> : null}
          {projection.interstellarStations.rows.length === 0 ? <EmptyPage>当前恒星系没有星际物流站。</EmptyPage> : <div className="system-space-station-stations">
            {projection.interstellarStations.rows.map((station) => <article key={station.entityId} data-native-system-station-entity={station.entityId}>
              <div><strong>{station.planetName} · {station.machineCount.toLocaleString("zh-CN")} 座</strong><small>Mk.{station.stationTier} · {modeLabel(station.operationMode)} · {transitionLabel(station.modeTransition)}</small></div>
              <div className="system-space-station-station-actions">
                {station.stationTier === 1 ? <button
                  type="button"
                  disabled={!commandsEnabled || !onUpgradeStation}
                  onClick={() => onUpgradeStation?.(station.entityId)}
                  data-native-system-station-command="upgrade-one"
                >升级 Mk.II</button> : null}
                <button
                  type="button"
                  className={station.effectiveTargetMode === "legacy" ? "active" : ""}
                  disabled={!commandsEnabled || station.stationTier !== 2 || station.effectiveTargetMode === "legacy" || !onRequestMode}
                  onClick={() => onRequestMode?.(station.entityId, "legacy")}
                  data-native-system-station-command="mode-legacy"
                >传统模式</button>
                <button
                  type="button"
                  className={station.effectiveTargetMode === "elevator" ? "active" : ""}
                  disabled={!commandsEnabled || station.stationTier !== 2 || station.effectiveTargetMode === "elevator" || !onRequestMode}
                  onClick={() => onRequestMode?.(station.entityId, "elevator")}
                  data-native-system-station-command="mode-elevator"
                >电梯模式</button>
              </div>
              <div className="system-space-station-outputs">
                {station.outputTargets.map((target) => <NativeSystemStationOutputControl
                  key={target.portIndex}
                  entityId={station.entityId}
                  portIndex={target.portIndex}
                  itemId={target.itemId}
                  itemName={target.itemName}
                  disabled={!commandsEnabled || !station.outputConfigurationEnabled}
                  onSetOutput={onSetOutput}
                />)}
              </div>
              <small>{station.outputConfigurationEnabled ? "输出配置条件已满足；设置或清除必须连续确认两次" : `目标模式：${modeLabel(station.effectiveTargetMode)}`}</small>
            </article>)}
          </div>}
        </section>
      </> : null}
    </div>

    <footer className="system-space-station-footer">
      <span><ShieldCheck size={14} />仅消费 ≤1 MiB Rust 投影并提交有界意图；不读取、复制或回写完整 GameState</span>
      <button type="button" onClick={handleClose}><ArrowLeft size={15} />返回工厂</button>
    </footer>
  </WorkspaceFrame>;
}
