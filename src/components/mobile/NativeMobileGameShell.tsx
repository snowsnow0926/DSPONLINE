import {
  Bell,
  BoxSelect,
  ChevronLeft,
  Focus,
  LayoutGrid,
  Map,
  Orbit,
  PackageOpen,
  Pause,
  Play,
  Route,
  Undo2,
  Redo2,
  WandSparkles,
  Wrench,
  Zap,
} from "lucide-react";
import type { NativeAuthoritativeFactoryWorkspaceFrame } from "../../game/nativeFactoryWorkspaceFrame";
import type { NativeConstructionInventoryFrame } from "../../game/nativeConstructionInventoryStore";
import type { NativeFactoryInventoryFrame } from "../../game/nativeFactoryInventoryStore";
import type { BeltTier, DraggedItemSourceKind, ItemId, PlanetId } from "../../game/types";
import type { CompactLayoutSnapshot } from "../../hooks/useCompactLayout";
import type { MobileOverlay, MobileRoute, MobileSheetId, MobileSheetSnap, MobileWorkspaceId } from "../../hooks/useMobileNavigation";
import type { OperationsTab } from "../OperationsWorkspace";
import type { StatisticsTab } from "../StatisticsWorkspace";
import { NativeConstructionDock } from "../NativeConstructionDock";
import { NativeResourceRail } from "../NativeResourceRail";
import { MobileBottomNav } from "./MobileBottomNav";
import type { MobileCanvasToolActions, MobileCanvasToolState } from "./MobileSheets";
import { MobileSheetFrame } from "./MobileSheetFrame";
import { MobileWorkspaceHub } from "./MobileWorkspaceHub";

const WORKSPACE_TITLES: Readonly<Record<string, string>> = {
  technology: "科技树",
  statistics: "生产统计",
  recipes: "生产资料库",
  "star-map": "星图与星际工业",
  blueprints: "蓝图库",
  dyson: "戴森规划",
  campaign: "主线任务",
  operations: "运营中心",
  galaxy: "银河网络",
  "construction-center": "建筑制造中心",
  "orbital-station": "全星系空间站",
};

interface NativeMobileGameShellProps {
  enabled: boolean;
  layout: CompactLayoutSnapshot;
  frame: NativeAuthoritativeFactoryWorkspaceFrame | null;
  inventoryFrame: NativeFactoryInventoryFrame | null;
  constructionFrame: NativeConstructionInventoryFrame | null;
  pending: boolean;
  alertCount: number;
  route: MobileRoute;
  overlay: MobileOverlay;
  tools: MobileCanvasToolState;
  toolActions: MobileCanvasToolActions;
  selectedBuildingId: string | null;
  selectedBeltTier: BeltTier | null;
  beltLanes: number;
  hasConstructionCenter: boolean;
  onPlacementChange: (buildingId: string | null) => void;
  onBeltPlacementChange: (tier: BeltTier | null) => void;
  onBeltLanesChange: (lanes: number) => void;
  onDeleteConstruction: (buildingId: string) => void;
  onOpenFabricator: () => void;
  onPickTray: (itemId: string) => void;
  onDropCargo: () => void;
  onStowEntityInventory: (
    itemId: ItemId,
    sourceKind: Extract<DraggedItemSourceKind, "node" | "node-input">,
    sourceId: string,
  ) => void;
  entityDepositEnabled: boolean;
  onSetTrayItemLimit: (value: number) => void;
  onSetProductionBufferLimit: (value: number) => void;
  onDiscardTrayItem: (itemId: string, amount: number) => void;
  onFactory: () => void;
  onOpenHub: () => void;
  onOpenSheet: (id: MobileSheetId) => void;
  onSheetSnap: (snap: MobileSheetSnap) => void;
  onOpenWorkspace: (id: MobileWorkspaceId) => void;
  onOpenOrbitalStation: () => void;
  onOpenStatistics: (tab: StatisticsTab) => void;
  onOpenOperations: (tab: OperationsTab) => void;
  onOpenGalaxy: (tab: "ranking" | "cloud" | "account") => void;
  onOpenCommandPalette: () => void;
  onBack: () => void;
  onTogglePause: () => void;
  onPlanetChange: (planetId: PlanetId) => boolean;
  onConfirmExit: () => void;
  onDismissExit: () => void;
  onRequestExit: () => void;
  onSwitchLegacy: () => void;
}

function NativeMobileTopBar({ frame, route, alertCount, pending, onBack, onOpenPlanet, onTogglePause, onOpenAlerts }: {
  frame: NativeAuthoritativeFactoryWorkspaceFrame | null;
  route: MobileRoute;
  alertCount: number;
  pending: boolean;
  onBack: () => void;
  onOpenPlanet: () => void;
  onTogglePause: () => void;
  onOpenAlerts: () => void;
}) {
  if (route.kind !== "factory") {
    const title = route.kind === "hub" ? "更多工作区" : WORKSPACE_TITLES[route.id] ?? route.id;
    return <header className="mobile-next-topbar mobile-next-topbar--workspace" data-native-mobile-topbar="true">
      <button type="button" onClick={onBack} aria-label={`返回工厂，关闭${title}`}><ChevronLeft size={22} /><span>返回</span></button>
      <div><small>Rust 单权威</small><strong>{title}</strong></div><span className="mobile-next-topbar__spacer" />
    </header>;
  }
  const active = frame?.planetNavigation.planets.rows.find((row) => row.active) ?? null;
  const powerPercent = Math.round((active?.powerFactor ?? 0) * 100);
  const paused = frame?.runStatus.paused ?? true;
  return <header className="mobile-next-topbar" data-native-mobile-topbar="true">
    <button className="mobile-next-planet-command" type="button" disabled={!frame || pending} onClick={onOpenPlanet} aria-label={`切换行星，当前${active?.displayName ?? "等待原生投影"}`}>
      <Orbit size={20} /><span><strong>{active?.displayName ?? "同步中"}</strong><small>{active?.code ?? "Rust"}</small></span>
    </button>
    <div className={`mobile-next-power mobile-next-power--${powerPercent >= 100 ? "positive" : powerPercent > 0 ? "warning" : "negative"}`} aria-label={`供电效率 ${powerPercent}%`}><Zap size={18} /><span>供电</span><strong>{powerPercent}%</strong></div>
    <button type="button" disabled={!frame || pending} onClick={onTogglePause} aria-label={paused ? "继续模拟" : "暂停模拟"}>{paused ? <Play size={21} /> : <Pause size={21} />}</button>
    <button className={alertCount > 0 ? "has-alerts" : ""} type="button" onClick={onOpenAlerts} aria-label={`打开警报，当前 ${alertCount} 条`}><Bell size={21} />{alertCount > 0 ? <b>{Math.min(99, alertCount)}</b> : null}</button>
  </header>;
}

function NativePlanetSheet({ frame, snap, pending, onSnap, onClose, onPlanetChange, onOpenStarMap }: {
  frame: NativeAuthoritativeFactoryWorkspaceFrame | null;
  snap: MobileSheetSnap;
  pending: boolean;
  onSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
  onPlanetChange: (planetId: PlanetId) => boolean;
  onOpenStarMap: () => void;
}) {
  return <MobileSheetFrame title="切换行星" detail="同 revision 的 Rust 行星目录" snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-planet-sheet">
    <div className="mobile-next-planet-list">
      {(frame?.planetNavigation.planets.rows ?? []).filter((row) => row.colonized).map((row) => <button className={row.active ? "active" : ""} type="button" disabled={pending} aria-pressed={row.active} key={row.planetId} onClick={() => { if (onPlanetChange(row.planetId as PlanetId)) onClose(); }}>
        <i><Orbit size={21} /></i><span><strong>{row.displayName}</strong><small>{row.code} · {row.systemId ?? "未知星系"}</small></span><em>{row.deviceCount} 台<br />供电 {Math.round(row.powerFactor * 100)}%</em>
      </button>)}
      {!frame ? <p role="status">正在等待原生行星投影；不会读取旧 JavaScript 存档。</p> : null}
    </div>
    <button className="mobile-next-sheet-primary" type="button" onClick={onOpenStarMap}><Map size={19} /><span><strong>打开原生星图</strong><small>勘探、殖民和跨星旅行</small></span></button>
  </MobileSheetFrame>;
}

function NativeToolsSheet({ state, actions, snap, pending, onSnap, onClose }: {
  state: MobileCanvasToolState;
  actions: MobileCanvasToolActions;
  snap: MobileSheetSnap;
  pending: boolean;
  onSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
}) {
  const run = (action: () => void) => { action(); onClose(); };
  return <MobileSheetFrame title="画布工具" detail="手势只保存本地草稿，最终由 Rust 提交" snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-tools-sheet">
    <div className="mobile-next-tool-groups">
      <section><header>操作模式</header><div>
        <button type="button" disabled={pending} onClick={() => run(actions.onBrowse)}><Focus size={20} /><span>浏览画布</span></button>
        <button type="button" disabled={pending} onClick={() => run(actions.onSelect)}><BoxSelect size={20} /><span>逐点多选</span></button>
        <button type="button" disabled={pending} onClick={() => run(actions.onRegion)}><LayoutGrid size={20} /><span>生产区域</span><b>{state.regionCount}</b></button>
        <button type="button" disabled={pending} onClick={() => run(actions.onLayout)}><WandSparkles size={20} /><span>移动节点</span></button>
      </div></section>
      <section><header>网络与历史</header><div>
        <button type="button" disabled={pending} onClick={() => run(actions.onOpenBlueprints)}><PackageOpen size={20} /><span>蓝图库</span><b>{state.blueprintCount}</b></button>
        <button type="button" disabled={pending} onClick={() => run(actions.onOpenNetworks)}><Route size={20} /><span>生产网络</span><b>{state.beltCount}</b></button>
        <button type="button" disabled={pending} className={state.batchConnectionMode ? "active" : ""} onClick={() => run(() => actions.onBatchConnectionModeChange(!state.batchConnectionMode))}><Route size={20} /><span>连续拉线</span></button>
        <button type="button" disabled={pending} onClick={() => run(actions.onAutoLayout)}><WandSparkles size={20} /><span>自动整理</span></button>
        <button type="button" disabled={pending || !state.canUndo} onClick={actions.onUndo}><Undo2 size={20} /><span>撤销</span></button>
        <button type="button" disabled={pending || !state.canRedo} onClick={actions.onRedo}><Redo2 size={20} /><span>重做</span></button>
      </div></section>
    </div>
  </MobileSheetFrame>;
}

export function NativeMobileGameShell(props: NativeMobileGameShellProps) {
  if (!props.enabled) return null;
  const openSheet = (id: MobileSheetId) => props.onOpenSheet(id);
  const openWorkspace = (id: MobileWorkspaceId) => props.onOpenWorkspace(id);
  const close = props.onBack;
  let sheet = null;
  if (props.overlay?.kind === "modal" && props.overlay.id === "exit") {
    sheet = <div className="mobile-next-confirm-backdrop" role="presentation"><section className="mobile-next-confirm" role="alertdialog" aria-modal="true" aria-label="保存并返回主菜单"><span><strong>保存并返回主菜单？</strong><small>Rust 会先生成并验证当前 revision 的 durable 检查点。</small></span><footer><button type="button" onClick={props.onDismissExit}>继续游戏</button><button className="primary" type="button" onClick={props.onConfirmExit}>保存并返回</button></footer></section></div>;
  } else if (props.overlay?.kind === "modal" && props.overlay.id === "offline") {
    sheet = <div className="mobile-next-confirm-backdrop" role="presentation"><section className="mobile-next-confirm" role="dialog" aria-modal="true" aria-label="原生离线结算"><span><strong>原生离线结算已完成</strong><small>工厂画面只会在新的 Rust revision 到达后整体刷新，不会显示旧 JavaScript 状态。</small></span><footer><button className="primary" type="button" onClick={props.onDismissExit}>查看工厂</button></footer></section></div>;
  } else if (props.overlay?.kind === "sheet") {
    const { id, snap } = props.overlay;
    if (id === "planet") sheet = <NativePlanetSheet frame={props.frame} snap={snap} pending={props.pending} onSnap={props.onSheetSnap} onClose={close} onPlanetChange={props.onPlanetChange} onOpenStarMap={() => openWorkspace("star-map")} />;
    else if (id === "tools") sheet = <NativeToolsSheet state={props.tools} actions={props.toolActions} snap={snap} pending={props.pending} onSnap={props.onSheetSnap} onClose={close} />;
    else if (id === "build") sheet = <MobileSheetFrame title="建造" detail="Rust 施工库存与语义放置" snap={snap} onSnap={props.onSheetSnap} onClose={close}><NativeConstructionDock frame={props.constructionFrame} selectedBuildingId={props.selectedBuildingId} selectedBeltTier={props.selectedBeltTier} beltLanes={props.beltLanes} pending={props.pending} onPlacementChange={(id) => { props.onPlacementChange(id); if (id) close(); }} onBeltPlacementChange={(tier) => { props.onBeltPlacementChange(tier); if (tier) close(); }} onBeltLanesChange={props.onBeltLanesChange} onOpenFabricator={props.onOpenFabricator} onDeleteConstruction={props.onDeleteConstruction} /></MobileSheetFrame>;
    else if (id === "inventory") sheet = <MobileSheetFrame title="物资" detail="Rust 权威托盘与手持物" snap={snap} onSnap={props.onSheetSnap} onClose={close}><NativeResourceRail frame={props.inventoryFrame} pending={props.pending} onPickTray={props.onPickTray} onDropCargo={props.onDropCargo} onStowEntityInventory={props.onStowEntityInventory} entityDepositEnabled={props.entityDepositEnabled} onSetTrayItemLimit={props.onSetTrayItemLimit} onSetProductionBufferLimit={props.onSetProductionBufferLimit} onDiscardTrayItem={props.onDiscardTrayItem} /></MobileSheetFrame>;
    else sheet = <MobileSheetFrame title="原生检查器" detail="与桌面共用同一 Rust 选择投影" snap={snap} allowPeek onSnap={props.onSheetSnap} onClose={close}><p role="status">检查器已绑定当前选择；所有按钮复用桌面原生命令，不读取旧完整状态。</p></MobileSheetFrame>;
  }
  return <div data-native-mobile-shell="thin-v1" data-native-revision={props.frame?.revision ?? "loading"}>
    <NativeMobileTopBar frame={props.frame} route={props.route} alertCount={props.alertCount} pending={props.pending} onBack={props.onBack} onOpenPlanet={() => openSheet("planet")} onTogglePause={props.onTogglePause} onOpenAlerts={() => props.onOpenOperations("alerts")} />
    {props.route.kind === "hub" ? <MobileWorkspaceHub hasConstructionCenter={props.hasConstructionCenter} onOpenWorkspace={openWorkspace} onOpenOrbitalStation={props.onOpenOrbitalStation} onOpenStatistics={props.onOpenStatistics} onOpenOperations={props.onOpenOperations} onOpenGalaxy={props.onOpenGalaxy} onOpenCommandPalette={props.onOpenCommandPalette} onSwitchLegacy={props.onSwitchLegacy} onRequestExit={props.onRequestExit} onClose={props.onBack} /> : null}
    {props.route.kind === "factory" && !props.overlay ? <button className="mobile-next-tools-command" type="button" onClick={() => openSheet("tools")} aria-label="打开画布工具"><Wrench size={22} /></button> : null}
    {sheet}
    <MobileBottomNav route={props.route} overlay={props.overlay} cargoAmount={props.inventoryFrame?.cargo?.amount ?? 0} onFactory={props.onFactory} onBuild={() => openSheet("build")} onInventory={() => openSheet("inventory")} onTechnology={() => openWorkspace("technology")} onHub={props.onOpenHub} />
    <span className="mobile-next-layout-probe" data-mode={props.layout.mode} aria-hidden="true" />
  </div>;
}
