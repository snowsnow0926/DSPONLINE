import { BoxSelect, ChevronRight, Focus, Layers3, LayoutTemplate, LockKeyhole, Map, MapPin, MousePointer2, Orbit, Palette, Redo2, Route, Truck, Undo2, WandSparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState } from "react";
import { PLANET_LIST, getPlanet } from "../../game/content";
import { getPlanetMetrics, isPlanetColonized, type PlanetTrayDiscardRequest } from "../../game/engine";
import { getPlanetDisplayName } from "../../game/galaxy";
import type { FactoryInspectorSummaryReadModel } from "../../game/factoryReadModels";
import type { BeltConnection, BeltTier, BuildingId, ConstructionId, FactoryEntity, GameState, ItemId, MaterialDeliverySlotMode, PlanetId, RecipeId } from "../../game/types";
import type { MobileOverlay, MobileSheetSnap } from "../../hooks/useMobileNavigation";
import { MobileBuildSheet, MobileInspectorSheet, MobileInventorySheet, type MobileCanvasMode } from "./MobileFactoryPanels";
import { MobileSheetFrame } from "./MobileSheetFrame";
import { clearStableTextDraft } from "../CompositionSafeInput";

export interface MobileCanvasToolState {
  mode: MobileCanvasMode;
  blueprintCount: number;
  beltCount: number;
  regionCount: number;
  canUndo: boolean;
  canRedo: boolean;
  canUndoAutoLayout: boolean;
  minimapOpen: boolean;
  batchConnectionMode: boolean;
}

export interface MobileCanvasToolActions {
  onBrowse: () => void;
  onSelect: () => void;
  onRegion: () => void;
  onLayout: () => void;
  onOpenBlueprints: () => void;
  onOpenNetworks: () => void;
  onBatchConnectionModeChange: (enabled: boolean) => void;
  onAutoLayout: () => void;
  onUndoAutoLayout: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onToggleMinimap: () => void;
}

export interface MobileFactorySheetState {
  placement: BuildingId | null;
  beltTier: BeltTier;
  beltTierMode: "auto" | "manual";
  selectedEntity: FactoryEntity | null;
  selectedBelt: BeltConnection | null;
  selectedCount: number;
  inspectorReadModel: FactoryInspectorSummaryReadModel;
}

export interface MobileFactorySheetActions {
  onPlacement: (buildingId: BuildingId) => void;
  onBelt: (tier: BeltTier) => void;
  onCraft: (constructionId: ConstructionId) => void;
  onCraftFleet: (recipeId: RecipeId) => void;
  onMissingCraft: (constructionId: ConstructionId) => void;
  onDeleteConstruction: (constructionId: ConstructionId) => Promise<boolean>;
  onPickTray: (itemId: ItemId) => void;
  onDropCargo: () => void;
  onDiscardTrayItems: (requests: PlanetTrayDiscardRequest[]) => void;
  onSetTrayItemLimit: (value: number) => void;
  onFocusSelection: () => void;
  onAddEntity: (entityId: string, count: number) => void;
  onRemoveEntity: (entityId: string, count?: number) => void;
  onUpgradeEntity: (entityId: string) => void;
  onUpgradeInterstellarStation: (entityId: string) => void;
  onQuantumAttachment: (entityId: string) => void;
  onOrbitalCollectorQuantumMode: (entityId: string, enabled: boolean) => void;
  onUpgradeBelt: (beltId: string) => void;
  onBeltLaneCountChange: (beltId: string, targetLanes: number) => void;
  onEntityLockChange: (entityId: string, locked: boolean) => void;
  onRemoveSprayCoater: (entityId: string) => void;
  onOpenResourceSettings: () => void;
  onMaterialDeliverySlotChange: (entityId: string, slotIndex: number, mode: MaterialDeliverySlotMode, itemId: ItemId | null) => void;
  onEjectorOrbitChange: (entityId: string, orbitId: string) => void;
}

function PlanetSheet({ game, planetAlertCounts, snap, onSnap, onPlanetChange, onOpenStarMap, onClose }: {
  game: GameState;
  planetAlertCounts: Partial<Record<PlanetId, number>>;
  snap: MobileSheetSnap;
  onSnap: (snap: MobileSheetSnap) => void;
  onPlanetChange: (planetId: PlanetId) => boolean;
  onOpenStarMap: () => void;
  onClose: () => void;
}) {
  const colonized = PLANET_LIST.filter((planet) => isPlanetColonized(game, planet.id));
  return (
    <MobileSheetFrame title="切换行星" detail="已殖民行星与当前工厂状态" snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-planet-sheet">
      {game.cargo ? <p className="mobile-next-cargo-note"><Orbit size={16} />手提 {game.cargo.amount.toLocaleString("zh-CN")} 个物资，将随你抵达目标行星</p> : null}
      <div className="mobile-next-planet-list">
        {colonized.map((planet) => {
          const active = game.activePlanetId === planet.id;
          const metrics = getPlanetMetrics(game, planet.id);
          const devices = game.entities.reduce((sum, entity) => entity.planetId === planet.id ? sum + entity.machineCount + entity.minerCount : sum, 0);
          const issues = planetAlertCounts[planet.id] ?? 0;
          return <button className={active ? "active" : ""} type="button" aria-pressed={active} key={planet.id} onClick={() => {
            if (onPlanetChange(planet.id)) onClose();
          }}>
            <i style={{ color: planet.color }}><Orbit size={21} /></i>
            <span><strong>{getPlanetDisplayName(game, planet.id)}</strong><small>{planet.code} · {planet.environment}</small></span>
            <em>{devices} 台<br />供电 {Math.round(metrics.powerFactor * 100)}%</em>
            {issues > 0 ? <b>{issues} 项</b> : <ChevronRight size={18} />}
          </button>;
        })}
      </div>
      <button className="mobile-next-sheet-primary" type="button" onClick={onOpenStarMap}><MapPin size={19} /><span><strong>打开星图与行星探索</strong><small>查看未殖民行星、资源和解锁条件</small></span><ChevronRight size={18} /></button>
    </MobileSheetFrame>
  );
}

function ToolsSheet({ state, actions, snap, onSnap, onClose }: { state: MobileCanvasToolState; actions: MobileCanvasToolActions; snap: MobileSheetSnap; onSnap: (snap: MobileSheetSnap) => void; onClose: () => void }) {
  const runAndClose = (action: () => void) => { action(); onClose(); };
  return (
    <MobileSheetFrame title="画布工具" detail="选择、布局、整理与视角" snap={snap} onSnap={onSnap} onClose={onClose} className="mobile-tools-sheet">
      <div className="mobile-next-tool-groups">
        <section><header>操作模式</header><div>
          <button className={state.mode === "browse" ? "active" : ""} type="button" onClick={() => runAndClose(actions.onBrowse)}><MousePointer2 size={20} /><span>浏览画布</span></button>
          <button className={state.mode === "layout" ? "active" : ""} type="button" onClick={() => runAndClose(actions.onLayout)}><LayoutTemplate size={20} /><span>移动节点</span></button>
          <button className={state.mode === "select" ? "active" : ""} type="button" onClick={() => runAndClose(actions.onSelect)}><BoxSelect size={20} /><span>逐点多选</span></button>
          <button className={state.mode === "region" ? "active" : ""} type="button" onClick={() => runAndClose(actions.onRegion)}><Palette size={20} /><span>生产区域</span><b>{state.regionCount}</b></button>
        </div></section>
        <section><header>生产网络</header><div>
          <button type="button" onClick={() => runAndClose(actions.onOpenBlueprints)}><Layers3 size={20} /><span>蓝图库</span><b>{state.blueprintCount}</b></button>
          <button type="button" onClick={() => runAndClose(actions.onOpenNetworks)}><Route size={20} /><span>连续网络</span><b>{state.beltCount}</b></button>
          <button className={state.batchConnectionMode ? "active" : ""} type="button" aria-label="连续拉线模式" aria-pressed={state.batchConnectionMode} onClick={() => runAndClose(() => actions.onBatchConnectionModeChange(!state.batchConnectionMode))}><Truck size={20} /><span>连续拉线</span></button>
          <button type="button" onClick={() => runAndClose(actions.onAutoLayout)}><WandSparkles size={20} /><span>自动整理</span></button>
          <button type="button" disabled={!state.canUndoAutoLayout} onClick={() => runAndClose(actions.onUndoAutoLayout)}><Undo2 size={20} /><span>撤销整理</span></button>
        </div></section>
        <section><header>视角与历史</header><div>
          <button type="button" disabled={!state.canUndo} onClick={actions.onUndo}><Undo2 size={20} /><span>撤销</span></button>
          <button type="button" disabled={!state.canRedo} onClick={actions.onRedo}><Redo2 size={20} /><span>重做</span></button>
          <button type="button" onClick={actions.onZoomOut}><ZoomOut size={20} /><span>缩小</span></button>
          <button type="button" onClick={actions.onZoomIn}><ZoomIn size={20} /><span>放大</span></button>
          <button type="button" onClick={() => runAndClose(actions.onFitView)}><Focus size={20} /><span>定位全部</span></button>
          <button className={state.minimapOpen ? "active" : ""} type="button" onClick={actions.onToggleMinimap}><Map size={20} /><span>小地图</span></button>
        </div></section>
      </div>
    </MobileSheetFrame>
  );
}

export function MobileSheets({ game, factoryGame, planetAlertCounts, overlay, tools, toolActions, factory, factoryActions, onSheetSnap, onClose, onPlanetChange, onOpenStarMap, onConfirmExit, onDismissExit }: {
  game: GameState;
  /** Same-revision bounded rows for inspector reads; other sheets keep full Web state. */
  factoryGame: GameState;
  planetAlertCounts: Partial<Record<PlanetId, number>>;
  overlay: MobileOverlay;
  tools: MobileCanvasToolState;
  toolActions: MobileCanvasToolActions;
  factory: MobileFactorySheetState;
  factoryActions: MobileFactorySheetActions;
  onSheetSnap: (snap: MobileSheetSnap) => void;
  onClose: () => void;
  onPlanetChange: (planetId: PlanetId) => boolean;
  onOpenStarMap: () => void;
  onConfirmExit: () => void;
  onDismissExit: () => void;
}) {
  const [buildQuery, setBuildQuery] = useState("");
  useEffect(() => {
    if (overlay?.kind !== "sheet" || overlay.id !== "build") {
      setBuildQuery("");
      clearStableTextDraft("mobile-build-search");
    }
    if (overlay?.kind !== "sheet" || overlay.id !== "inventory") clearStableTextDraft("mobile-inventory-search");
  }, [overlay]);
  if (!overlay) return null;
  if (overlay.kind === "modal") {
    // Command and offline reports own their dialog. Only an explicit exit
    // request may render the save-and-return confirmation here.
    if (overlay.id !== "exit") return null;
    return <div className="mobile-next-confirm-backdrop" role="presentation"><section className="mobile-next-confirm" role="alertdialog" aria-modal="true" aria-label="保存并返回主菜单"><i><LockKeyhole size={24} /></i><span><strong>保存并返回主菜单？</strong><small>系统会先校验主存档，保存失败时不会离开当前工厂。</small></span><footer><button type="button" onClick={onDismissExit}>继续游戏</button><button className="primary" type="button" onClick={onConfirmExit}>保存并返回</button></footer></section></div>;
  }
  if (overlay.id === "planet") return <PlanetSheet game={game} planetAlertCounts={planetAlertCounts} snap={overlay.snap} onSnap={onSheetSnap} onPlanetChange={onPlanetChange} onOpenStarMap={onOpenStarMap} onClose={onClose} />;
  if (overlay.id === "tools") return <ToolsSheet state={tools} actions={toolActions} snap={overlay.snap} onSnap={onSheetSnap} onClose={onClose} />;
  if (overlay.id === "build") return <MobileBuildSheet game={game} snap={overlay.snap} placement={factory.placement} beltTier={factory.beltTier} beltTierMode={factory.beltTierMode} query={buildQuery} onQueryChange={setBuildQuery} onSnap={onSheetSnap} onClose={onClose} onPlacement={factoryActions.onPlacement} onBelt={factoryActions.onBelt} onCraft={factoryActions.onCraft} onCraftFleet={factoryActions.onCraftFleet} onMissingCraft={factoryActions.onMissingCraft} onDeleteConstruction={factoryActions.onDeleteConstruction} />;
  if (overlay.id === "inventory") return <MobileInventorySheet game={game} snap={overlay.snap} onSnap={onSheetSnap} onClose={onClose} onPickTray={factoryActions.onPickTray} onDropCargo={factoryActions.onDropCargo} onDiscardTrayItems={factoryActions.onDiscardTrayItems} onSetTrayItemLimit={factoryActions.onSetTrayItemLimit} />;
  if (overlay.snap === "full") return <MobileSheetFrame title="完整检查器" detail="配方、物流槽、电网与高级设置" snap="full" allowPeek onSnap={onSheetSnap} onClose={onClose} className="mobile-inspector-sheet--advanced"><span aria-hidden="true" /></MobileSheetFrame>;
  return <MobileInspectorSheet game={factoryGame} snap={overlay.snap} entity={factory.selectedEntity} belt={factory.selectedBelt} selectedCount={factory.selectedCount} readModel={factory.inspectorReadModel} onSnap={onSheetSnap} onClose={onClose} onOpenAdvanced={() => onSheetSnap("full")} onFocus={factoryActions.onFocusSelection} onAddEntity={factoryActions.onAddEntity} onRemoveEntity={factoryActions.onRemoveEntity} onUpgradeEntity={factoryActions.onUpgradeEntity} onUpgradeInterstellarStation={factoryActions.onUpgradeInterstellarStation} onQuantumAttachment={factoryActions.onQuantumAttachment} onOrbitalCollectorQuantumMode={factoryActions.onOrbitalCollectorQuantumMode} onUpgradeBelt={factoryActions.onUpgradeBelt} onBeltLaneCountChange={factoryActions.onBeltLaneCountChange} onEntityLockChange={factoryActions.onEntityLockChange} onRemoveSprayCoater={factoryActions.onRemoveSprayCoater} onOpenResourceSettings={factoryActions.onOpenResourceSettings} onMaterialDeliverySlotChange={factoryActions.onMaterialDeliverySlotChange} onEjectorOrbitChange={factoryActions.onEjectorOrbitChange} />;
}
