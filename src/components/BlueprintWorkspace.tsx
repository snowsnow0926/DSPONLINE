import { ArrowUp, BoxSelect, Check, ChevronLeft, ChevronRight, Clock3, Copy, Download, FlipHorizontal2, Focus, Layers3, ListChecks, Lock, MousePointer2, PackageCheck, PackageOpen, Palette, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, Redo2, RotateCw, Route, Trash2, Truck, Undo2, Unlock, Upload, WandSparkles, X } from "lucide-react";
import { getConstructionDefinition, getItem, getPlanet, getRecipe, getRecipesForBuilding } from "../game/content";
import { canPlaceBlueprint, canQueueBlueprint, getBlueprintFleetLoadPreview, getBlueprintRequirements, getConstructionQueueDetails, isTechnologyCompleted, transformBlueprintOffset } from "../game/engine";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import type { BlueprintDefinition, BlueprintMirror, BlueprintRotation, CanvasRegion, CanvasViewport, GameState, PlanetId, RecipeId } from "../game/types";
import { Fragment, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useGameDialog } from "./GameDialogProvider";

function blueprintBuildingSummary(blueprint: BlueprintDefinition): string[] {
  const counts = new Map<string, number>();
  for (const entity of blueprint.entities) {
    const name = getConstructionDefinition(entity.buildingId)?.name ?? entity.buildingId;
    counts.set(name, (counts.get(name) ?? 0) + entity.machineCount);
  }
  for (const anchor of blueprint.resourceAnchors ?? []) {
    const name = getConstructionDefinition(anchor.extractorBuildingId)?.name ?? anchor.extractorBuildingId;
    counts.set(`${name}（资源锚点）`, (counts.get(`${name}（资源锚点）`) ?? 0) + anchor.minerCount);
  }
  return [...counts].map(([name, amount]) => `${name} ×${amount}`);
}

export function CanvasSelectionTools({ selectionMode, regionMode, lineFindMode, blueprintCount, beltCount, regionCount, canUndo, canRedo, canUndoAutoLayout, leftSidebarCollapsed, rightSidebarCollapsed, onModeChange, onRegionModeChange, onToggleLineFindMode, onOpenBlueprints, onOpenNetworks, onAutoLayout, onUndoAutoLayout, onUndo, onRedo, onToggleLeftSidebar, onToggleRightSidebar }: {
  selectionMode: boolean;
  regionMode: boolean;
  lineFindMode: boolean;
  blueprintCount: number;
  beltCount: number;
  regionCount: number;
  canUndo: boolean;
  canRedo: boolean;
  canUndoAutoLayout: boolean;
  leftSidebarCollapsed: boolean;
  rightSidebarCollapsed: boolean;
  onModeChange: (enabled: boolean) => void;
  onRegionModeChange: (enabled: boolean) => void;
  onToggleLineFindMode: () => void;
  onOpenBlueprints: () => void;
  onOpenNetworks: () => void;
  onAutoLayout: () => void;
  onUndoAutoLayout: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`canvas-selection-tools nodrag nopan${collapsed ? " canvas-selection-tools--collapsed" : ""}`} aria-label="画布选择工具">
      {!collapsed ? <>
        <button className={!selectionMode && !regionMode ? "active" : ""} type="button" onClick={() => onModeChange(false)} title="指针与节点移动" aria-label="指针模式"><MousePointer2 size={16} /></button>
        <button className={selectionMode ? "active" : ""} type="button" onClick={() => onModeChange(true)} title="拖拽框选节点，可按 Shift 增减选择" aria-label="框选模式"><BoxSelect size={16} /></button>
        <button className={regionMode ? "active" : ""} type="button" onClick={() => onRegionModeChange(!regionMode)} title="在空白画布拖拽创建生产区域" aria-label="生产区域模式"><Palette size={16} /><em>{regionCount}</em></button>
        <button type="button" onClick={onOpenBlueprints} title="打开蓝图库" aria-label="打开蓝图库"><Layers3 size={16} /><em>{blueprintCount}</em></button>
        <button type="button" onClick={onOpenNetworks} title="打开生产网络总览" aria-label="打开生产网络总览"><Route size={16} /><em>{beltCount}</em></button>
        <button className={lineFindMode ? "active" : ""} type="button" onClick={onToggleLineFindMode} title="寻线模式：选中建筑后高亮上下游线路" aria-label="切换寻线模式" aria-pressed={lineFindMode} data-testid="line-find-toggle"><Route size={16} /></button>
        <button type="button" onClick={onAutoLayout} title="按物流上下游自动整理当前行星" aria-label="自动整理当前行星布局"><WandSparkles size={16} /></button>
        <button type="button" disabled={!canUndoAutoLayout} onClick={onUndoAutoLayout} title="恢复到最近一次自动整理前的位置" aria-label="撤销最近一次自动整理"><Undo2 size={16} /></button>
        <span className="canvas-selection-tools__separator" />
        <button type="button" disabled={!canUndo} onClick={onUndo} title="撤销上一步工厂操作 (Ctrl+Z)" aria-label="撤销"><Undo2 size={16} /></button>
        <button type="button" disabled={!canRedo} onClick={onRedo} title="重做工厂操作 (Ctrl+Y)" aria-label="重做"><Redo2 size={16} /></button>
        <span className="canvas-selection-tools__separator canvas-sidebar-toggle" />
        <button className="canvas-sidebar-toggle" type="button" onClick={onToggleLeftSidebar} title={leftSidebarCollapsed ? "展开物资侧栏" : "折叠物资侧栏"} aria-label={leftSidebarCollapsed ? "展开物资侧栏" : "折叠物资侧栏"}>{leftSidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        <button className="canvas-sidebar-toggle" type="button" onClick={onToggleRightSidebar} title={rightSidebarCollapsed ? "展开检查器侧栏" : "折叠检查器侧栏"} aria-label={rightSidebarCollapsed ? "展开检查器侧栏" : "折叠检查器侧栏"}>{rightSidebarCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}</button>
      </> : null}
      <button className="canvas-selection-tools__collapse" type="button" onClick={() => setCollapsed((current) => !current)} title={collapsed ? "展开画布工具" : "折叠画布工具"} aria-label={collapsed ? "展开画布工具" : "折叠画布工具"} aria-expanded={!collapsed}>
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </div>
  );
}

export interface CanvasRegionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasRegionResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const CANVAS_REGION_RESIZE_HANDLES: CanvasRegionResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CANVAS_REGION_RESIZE_LABELS: Record<CanvasRegionResizeHandle, string> = {
  n: "调整上边界",
  ne: "调整右上角",
  e: "调整右边界",
  se: "调整右下角",
  s: "调整下边界",
  sw: "调整左下角",
  w: "调整左边界",
  nw: "调整左上角",
};

export function CanvasRegionLayer({ regions, draft, selectedRegionId, resizePreview, resizeHandleSize = 16, onSelect, onResizeStart }: {
  regions: CanvasRegion[];
  draft: CanvasRegionRectangle | null;
  selectedRegionId: string | null;
  resizePreview?: { regionId: string; rectangle: CanvasRegionRectangle } | null;
  resizeHandleSize?: number;
  onSelect: (regionId: string) => void;
  onResizeStart?: (event: ReactPointerEvent<HTMLButtonElement>, region: CanvasRegion, handle: CanvasRegionResizeHandle) => void;
}) {
  return <>
    {regions.map((region) => {
      const rectangle = resizePreview?.regionId === region.id ? resizePreview.rectangle : region;
      const selected = selectedRegionId === region.id;
      const handleX = (handle: CanvasRegionResizeHandle) => handle.includes("w") ? rectangle.x : handle.includes("e") ? rectangle.x + rectangle.width : rectangle.x + rectangle.width / 2;
      const handleY = (handle: CanvasRegionResizeHandle) => handle.includes("n") ? rectangle.y : handle.includes("s") ? rectangle.y + rectangle.height : rectangle.y + rectangle.height / 2;
      return <Fragment key={region.id}>
        <div
          className={`canvas-region${selected ? " canvas-region--selected canvas-region--resizable" : ""}`}
          style={{
            left: rectangle.x,
            top: rectangle.y,
            width: rectangle.width,
            height: rectangle.height,
            borderColor: region.borderColor,
            backgroundColor: `${region.fillColor}24`,
            color: region.borderColor,
          } as CSSProperties}
        >
          <button className="canvas-region__label nodrag nopan" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelect(region.id); }} title={`编辑${region.name}`}><Palette size={12} /><span>{region.name}</span></button>
        </div>
        {selected ? CANVAS_REGION_RESIZE_HANDLES.map((handle) => <button
            className={`canvas-region__resize-handle canvas-region__resize-handle--${handle} nodrag nopan`}
            type="button"
            key={handle}
            style={{
              left: handleX(handle),
              top: handleY(handle),
              color: region.borderColor,
              "--canvas-region-handle-size": `${resizeHandleSize}px`,
            } as CSSProperties}
            aria-label={`${CANVAS_REGION_RESIZE_LABELS[handle]}：${region.name}`}
            title={CANVAS_REGION_RESIZE_LABELS[handle]}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onResizeStart?.(event, region, handle);
            }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
          />) : null}
      </Fragment>;
    })}
    {draft ? <div className="canvas-region canvas-region--draft" style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height } as CSSProperties}><span>新生产区域</span></div> : null}
  </>;
}

export function CanvasRegionEditor({ region, onChange, onRemove, onClose }: {
  region: CanvasRegion;
  onChange: (changes: Partial<Pick<CanvasRegion, "name" | "fillColor" | "borderColor">>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <section className="canvas-region-editor nodrag nopan" aria-label="生产区域设置">
      <Palette size={15} />
      <label><span>区域名称</span><input key={region.id} defaultValue={region.name} maxLength={28} onBlur={(event) => onChange({ name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      <label className="canvas-region-editor__color"><span>背景</span><input type="color" value={region.fillColor} onChange={(event) => onChange({ fillColor: event.target.value })} /></label>
      <label className="canvas-region-editor__color"><span>边框</span><input type="color" value={region.borderColor} onChange={(event) => onChange({ borderColor: event.target.value })} /></label>
      <button className="danger" type="button" onClick={onRemove} title="删除生产区域" aria-label="删除生产区域"><Trash2 size={14} /></button>
      <button type="button" onClick={onClose} title="关闭区域设置" aria-label="关闭区域设置"><X size={14} /></button>
    </section>
  );
}

export function SelectionToolbar({ selectedCount, selectedBeltCount, eligibleCount, canUpgrade, canUpgradeBelts, canLock, canUnlock, onFocus, onAutoLayout, onCopy, onUpgrade, onUpgradeBelts, onBatchIncrease, onLock, onUnlock, onRemove, onClear, onDone }: {
  selectedCount: number;
  selectedBeltCount: number;
  eligibleCount: number;
  canUpgrade: boolean;
  canUpgradeBelts: boolean;
  canLock: boolean;
  canUnlock: boolean;
  onFocus: () => void;
  onAutoLayout: () => void;
  onCopy: () => void;
  onUpgrade: () => void;
  onUpgradeBelts: () => void;
  onBatchIncrease: (amount: number) => void;
  onLock: () => void;
  onUnlock: () => void;
  onRemove: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const [customIncrease, setCustomIncrease] = useState("");
  const applyCustomIncrease = () => {
    if (!/^\d+$/.test(customIncrease.trim())) return;
    const amount = Number(customIncrease.trim());
    if (Number.isSafeInteger(amount) && amount >= 1 && amount <= 1_000_000) onBatchIncrease(amount);
  };
  if (selectedCount + selectedBeltCount === 0) return null;
  return (
    <div className="selection-toolbar nodrag nopan" role="toolbar" aria-label="选区操作">
      <span><BoxSelect size={14} /><strong>{selectedCount}</strong> 节点 · <strong>{selectedBeltCount}</strong> 线路</span>
      <button type="button" disabled={selectedCount === 0} onClick={onFocus} title="定位到所选设备" aria-label="定位到所选设备"><Focus size={16} /></button>
      <button type="button" disabled={selectedCount === 0} onClick={onAutoLayout} title="按物流上下游整理所选设备" aria-label="自动整理所选设备"><WandSparkles size={16} /></button>
      <button type="button" disabled={eligibleCount === 0} onClick={onCopy} title="复制所选设备为蓝图并进入粘贴" aria-label="复制所选为蓝图"><Copy size={16} /></button>
      <button type="button" disabled={!canUpgrade} onClick={onUpgrade} title="批量升级所有可升级设备" aria-label="批量升级所选设备"><ArrowUp size={16} /></button>
      <button type="button" disabled={!canUpgradeBelts} onClick={onUpgradeBelts} title="一键升级所有选中传送带并保持连接" aria-label="一键升级所选传送带"><Route size={16} /><ArrowUp size={12} /></button>
      <div className="selection-toolbar__batch" role="group" aria-label="批量增加建筑或传送带数量">
        {[1, 10, 100].map((amount) => <button type="button" key={amount} onClick={() => onBatchIncrease(amount)} title={`批量增加 ${amount}`}><Plus size={13} />{amount}</button>)}
        <input value={customIncrease} onChange={(event) => setCustomIncrease(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyCustomIncrease(); } }} inputMode="numeric" pattern="[0-9]*" min={1} max={1_000_000} placeholder="自定义" aria-label="自定义批量增加量" />
        <button type="button" onClick={applyCustomIncrease} title="应用自定义增加量" aria-label="应用自定义增加量"><Check size={13} /></button>
      </div>
      <button type="button" disabled={!canLock} onClick={onLock} title="锁定所选建筑" aria-label="锁定所选建筑"><Lock size={16} /></button>
      <button type="button" disabled={!canUnlock} onClick={onUnlock} title="解锁所选建筑" aria-label="解锁所选建筑"><Unlock size={16} /></button>
      <button className="danger" type="button" onClick={onRemove} title="批量回收所选设备与线路" aria-label="批量回收所选设备与线路"><Trash2 size={16} /></button>
      <button type="button" onClick={onClear} title="清空当前选择" aria-label="清空选择"><X size={16} /></button>
      <button className="confirm" type="button" onClick={onDone} title="完成多选并返回指针模式" aria-label="完成多选"><Check size={16} /></button>
    </div>
  );
}

export function BlueprintPlacementCursor({ blueprint, x, y }: { blueprint: BlueprintDefinition; x: number; y: number }) {
  return (
    <div className="blueprint-placement-cursor" style={{ left: x + 14, top: y + 14 }}>
      <Layers3 size={15} /><span>{blueprint.name}</span><strong>{blueprint.rotation ?? 0}°{blueprint.mirror === "horizontal" ? " · 镜像" : ""} · ×{blueprint.entities.length + (blueprint.resourceAnchors?.length ?? 0)}</strong>
    </div>
  );
}

interface PendingBlueprintGeometryNode {
  key: string;
  x: number;
  y: number;
  buildingId: string;
  amount: number;
  anchor: boolean;
  index: number;
}

interface PendingBlueprintGeometryLine {
  key: string;
  sourceKey: string;
  targetKey: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

interface PendingBlueprintGeometry {
  nodes: PendingBlueprintGeometryNode[];
  buckets: Map<string, number[]>;
  linesByNodeKey: Map<string, PendingBlueprintGeometryLine[]>;
}

const PENDING_BLUEPRINT_GEOMETRY_CELL = 640;
const PENDING_BLUEPRINT_NODE_RENDER_LIMIT = 900;
const PENDING_BLUEPRINT_LINE_RENDER_LIMIT = 1_400;
const pendingBlueprintGeometryCache = new Map<string, PendingBlueprintGeometry>();
const BLUEPRINT_VIEW_MODE_KEY = "dsp-idle-network.blueprint-view-mode.v1";

function readBlueprintViewMode(): "compact" | "detailed" {
  try {
    return window.localStorage.getItem(BLUEPRINT_VIEW_MODE_KEY) === "detailed" ? "detailed" : "compact";
  } catch {
    return "compact";
  }
}

function pendingBlueprintBucketKey(x: number, y: number): string {
  return `${Math.floor(x / PENDING_BLUEPRINT_GEOMETRY_CELL)}:${Math.floor(y / PENDING_BLUEPRINT_GEOMETRY_CELL)}`;
}

function getPendingBlueprintGeometry(
  cacheKey: string,
  blueprint: BlueprintDefinition,
  rotation: BlueprintRotation,
  mirror: BlueprintMirror,
): PendingBlueprintGeometry {
  const key = `${cacheKey}:${rotation}:${mirror}`;
  const cached = pendingBlueprintGeometryCache.get(key);
  if (cached) return cached;
  const nodes: PendingBlueprintGeometryNode[] = [
    ...blueprint.entities.map((entity, index) => {
      const offset = transformBlueprintOffset(entity.offset, rotation, mirror);
      return { key: entity.key, x: offset.x, y: offset.y, buildingId: entity.buildingId, amount: entity.machineCount, anchor: false, index };
    }),
    ...(blueprint.resourceAnchors ?? []).map((anchor, anchorIndex) => {
      const offset = transformBlueprintOffset(anchor.offset, rotation, mirror);
      return { key: anchor.key, x: offset.x, y: offset.y, buildingId: anchor.extractorBuildingId, amount: anchor.minerCount, anchor: true, index: blueprint.entities.length + anchorIndex };
    }),
  ];
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const bucketKey = pendingBlueprintBucketKey(node.x, node.y);
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(index);
    buckets.set(bucketKey, bucket);
  }
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const linesByNodeKey = new Map<string, PendingBlueprintGeometryLine[]>();
  for (const belt of blueprint.belts) {
    const source = nodeByKey.get(belt.sourceKey);
    const target = nodeByKey.get(belt.targetKey);
    if (!source || !target) continue;
    const line = {
      key: belt.key,
      sourceKey: source.key,
      targetKey: target.key,
      sourceX: source.x + 128,
      sourceY: source.y + 48,
      targetX: target.x + 128,
      targetY: target.y + 48,
    };
    for (const nodeKey of source.key === target.key ? [source.key] : [source.key, target.key]) {
      const lines = linesByNodeKey.get(nodeKey) ?? [];
      lines.push(line);
      linesByNodeKey.set(nodeKey, lines);
    }
  }
  const geometry = { nodes, buckets, linesByNodeKey };
  pendingBlueprintGeometryCache.set(key, geometry);
  while (pendingBlueprintGeometryCache.size > 32) pendingBlueprintGeometryCache.delete(pendingBlueprintGeometryCache.keys().next().value!);
  return geometry;
}

function getQueuedBlueprint(game: GameState, entry: GameState["constructionQueue"][number]): BlueprintDefinition | undefined {
  const snapshot = entry.blueprintVersionId
    ? game.blueprintVersions.find((candidate) => candidate.id === entry.blueprintVersionId)
    : undefined;
  return snapshot?.definition ?? game.blueprints.find((candidate) => candidate.id === entry.blueprintId);
}

export function PendingBlueprintLayer({ game, planetId, viewport, canvasSize }: {
  game: GameState;
  planetId: PlanetId;
  viewport: CanvasViewport;
  canvasSize: { width: number; height: number };
}) {
  const latestGameRef = useRef(game);
  latestGameRef.current = game;
  const geometryKey = game.constructionQueue
    .filter((entry) => entry.planetId === planetId && (entry.status ?? "pending-materials") === "pending-materials")
    .map((entry) => `${entry.id}:${entry.blueprintVersionId ?? `${entry.blueprintId}@${entry.blueprintRevision ?? 1}`}:${entry.position.x}:${entry.position.y}:${entry.rotation}:${entry.mirror}`)
    .join("|");
  const rendered = useMemo(() => {
    const currentGame = latestGameRef.current;
    const zoom = Math.max(0.25, viewport.zoom);
    const margin = 420 / zoom;
    const worldBounds = {
      left: -viewport.x / zoom - margin,
      top: -viewport.y / zoom - margin,
      right: (canvasSize.width - viewport.x) / zoom + margin,
      bottom: (canvasSize.height - viewport.y) / zoom + margin,
    };
    const nodes: Array<PendingBlueprintGeometryNode & { orderId: string; orderName: string; worldX: number; worldY: number }> = [];
    const lines: Array<PendingBlueprintGeometryLine & { orderId: string; worldSourceX: number; worldSourceY: number; worldTargetX: number; worldTargetY: number }> = [];
    const sortedEntries = currentGame.constructionQueue
      .filter((entry) => entry.planetId === planetId && (entry.status ?? "pending-materials") === "pending-materials")
      .sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
    for (const entry of sortedEntries) {
      if (nodes.length >= PENDING_BLUEPRINT_NODE_RENDER_LIMIT) break;
      const blueprint = getQueuedBlueprint(currentGame, entry);
      if (!blueprint) continue;
      const geometry = getPendingBlueprintGeometry(
        entry.blueprintVersionId ?? `${blueprint.id}@${entry.blueprintRevision ?? blueprint.revision ?? 1}`,
        blueprint,
        entry.rotation,
        entry.mirror,
      );
      const relativeBounds = {
        left: worldBounds.left - entry.position.x,
        top: worldBounds.top - entry.position.y,
        right: worldBounds.right - entry.position.x,
        bottom: worldBounds.bottom - entry.position.y,
      };
      const seenNodeIndexes = new Set<number>();
      const visibleNodeKeys = new Set<string>();
      const minBucketX = Math.floor(relativeBounds.left / PENDING_BLUEPRINT_GEOMETRY_CELL);
      const maxBucketX = Math.floor(relativeBounds.right / PENDING_BLUEPRINT_GEOMETRY_CELL);
      const minBucketY = Math.floor(relativeBounds.top / PENDING_BLUEPRINT_GEOMETRY_CELL);
      const maxBucketY = Math.floor(relativeBounds.bottom / PENDING_BLUEPRINT_GEOMETRY_CELL);
      for (let bucketY = minBucketY; bucketY <= maxBucketY && nodes.length < PENDING_BLUEPRINT_NODE_RENDER_LIMIT; bucketY += 1) {
        for (let bucketX = minBucketX; bucketX <= maxBucketX && nodes.length < PENDING_BLUEPRINT_NODE_RENDER_LIMIT; bucketX += 1) {
          for (const nodeIndex of geometry.buckets.get(`${bucketX}:${bucketY}`) ?? []) {
            if (seenNodeIndexes.has(nodeIndex)) continue;
            seenNodeIndexes.add(nodeIndex);
            const node = geometry.nodes[nodeIndex];
            if (node.x < relativeBounds.left || node.x > relativeBounds.right || node.y < relativeBounds.top || node.y > relativeBounds.bottom) continue;
            visibleNodeKeys.add(node.key);
            nodes.push({ ...node, orderId: entry.id, orderName: entry.blueprintName, worldX: entry.position.x + node.x, worldY: entry.position.y + node.y });
            if (nodes.length >= PENDING_BLUEPRINT_NODE_RENDER_LIMIT) break;
          }
        }
      }
      const seenLines = new Set<string>();
      for (const nodeKey of visibleNodeKeys) {
        for (const line of geometry.linesByNodeKey.get(nodeKey) ?? []) {
          if (lines.length >= PENDING_BLUEPRINT_LINE_RENDER_LIMIT || seenLines.has(line.key)) continue;
          seenLines.add(line.key);
          lines.push({
            ...line,
            orderId: entry.id,
            worldSourceX: entry.position.x + line.sourceX,
            worldSourceY: entry.position.y + line.sourceY,
            worldTargetX: entry.position.x + line.targetX,
            worldTargetY: entry.position.y + line.targetY,
          });
        }
      }
    }
    return { nodes, lines };
  }, [canvasSize.height, canvasSize.width, geometryKey, planetId, viewport.x, viewport.y, viewport.zoom]);
  if (rendered.nodes.length === 0) return null;
  const compact = viewport.zoom < 0.55;
  return <div className={`pending-blueprint-layer${compact ? " pending-blueprint-layer--compact" : ""}`} aria-hidden="true">
    {rendered.lines.map((line) => {
      const dx = line.worldTargetX - line.worldSourceX;
      const dy = line.worldTargetY - line.worldSourceY;
      return <i
        className="pending-blueprint-line"
        key={`${line.orderId}:${line.key}`}
        style={{ left: line.worldSourceX, top: line.worldSourceY, width: Math.hypot(dx, dy), transform: `rotate(${Math.atan2(dy, dx)}rad)` }}
      />;
    })}
    {rendered.nodes.map((node) => <div
      className={`pending-blueprint-node${node.anchor ? " pending-blueprint-node--anchor" : ""}`}
      key={`${node.orderId}:${node.key}`}
      style={{ left: node.worldX, top: node.worldY }}
    >
      <span>{getConstructionDefinition(node.buildingId)?.name ?? node.buildingId}</span>
      <strong title={formatQuantityExact(node.amount)}>×{formatQuantityCompact(node.amount)}</strong>
      {node.index === 0 ? <em>{node.orderName}</em> : null}
    </div>)}
  </div>;
}

function formatSimulationTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function BlueprintWorkspace({ open, game, onClose, onDeploy, onRemove, onRename, onTransform, onRecipeOverride, onFundQueue, onFundAllQueues, onCancelQueue, onExport, onImport, mobile = false, mobileSubview, onMobileOpenDetail }: {
  open: boolean;
  game: GameState;
  onClose: () => void;
  onDeploy: (blueprintId: string) => void;
  onRemove: (blueprintId: string) => void;
  onRename: (blueprintId: string, name: string) => void;
  onTransform: (blueprintId: string, rotation: BlueprintRotation, mirror: BlueprintMirror) => void;
  onRecipeOverride: (blueprintId: string, sourceRecipeId: RecipeId, targetRecipeId: RecipeId) => void;
  onFundQueue: (entryId: string, scope: "construction" | "fleet" | "all") => void;
  onFundAllQueues: () => void;
  onCancelQueue: (entryId: string) => void;
  onExport: (blueprintId: string) => void;
  onImport: (raw: string) => { success: boolean; message: string };
  mobile?: boolean;
  mobileSubview?: string | null;
  onMobileOpenDetail?: (subview: string) => void;
}) {
  const gameDialog = useGameDialog();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"library" | "pending">("library");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"compact" | "detailed">(readBlueprintViewMode);
  const setBlueprintViewMode = (mode: "compact" | "detailed") => {
    setViewMode(mode);
    try { window.localStorage.setItem(BLUEPRINT_VIEW_MODE_KEY, mode); } catch { /* device preference is best effort */ }
  };
  const requestDeploy = async (blueprint: BlueprintDefinition) => {
    const autoEnabled = blueprint.entities.some((entity) => entity.buildingId === "micro_black_hole_connector" && entity.operationEnabledOnDeploy === true);
    if (autoEnabled) {
      const confirmed = await gameDialog.confirm("此蓝图包含部署后自动启用的微型黑洞连接装置。输入物资会被永久销毁，是否继续？", {
        confirmLabel: "确认并部署",
        cancelLabel: "取消",
      });
      if (!confirmed) return;
    }
    onDeploy(blueprint.id);
  };
  const importRaw = (raw: string) => {
    const result = onImport(raw);
    setImportMessage(result.message);
    if (result.success) {
      setImportText("");
      window.setTimeout(() => {
        setImportOpen(false);
        setImportMessage(null);
      }, 900);
    }
  };
  if (!open) return null;
  const detailBlueprintId = mobile && mobileSubview?.startsWith("blueprint:") ? mobileSubview.slice(10) : null;
  const visibleBlueprints = detailBlueprintId ? game.blueprints.filter((blueprint) => blueprint.id === detailBlueprintId) : game.blueprints;
  const pendingCount = game.constructionQueue.length;
  return (
    <section className={`blueprint-workspace${mobile ? ` mobile-workspace mobile-blueprints${detailBlueprintId ? " mobile-workspace--detail" : ""}` : ""}`} role="dialog" aria-modal="true" aria-label="蓝图与待建施工">
      <header className="blueprint-header">
        <div className="blueprint-title"><i><Layers3 size={20} /></i><div><span>生产网络模板</span><strong>{activeTab === "library" ? "蓝图库" : "待建与补足"}</strong></div></div>
        <div className="blueprint-headline"><span>模板 <strong>{game.blueprints.length}</strong></span><span>施工队列 <strong>{game.constructionQueue.length}</strong></span><span>部署行星 <strong>{getPlanet(game.activePlanetId).name}</strong></span></div>
        <div className="blueprint-header-actions">{activeTab === "library" ? <>
          <div className="blueprint-view-mode" role="group" aria-label="蓝图卡片显示模式">
            <button className={viewMode === "compact" ? "active" : ""} type="button" aria-pressed={viewMode === "compact"} onClick={() => setBlueprintViewMode("compact")} title="只显示部署所需摘要">精简</button>
            <button className={viewMode === "detailed" ? "active" : ""} type="button" aria-pressed={viewMode === "detailed"} onClick={() => setBlueprintViewMode("detailed")} title="显示蓝图完整参数">详细</button>
          </div>
          <button className="blueprint-import-open" type="button" onClick={() => {
            setImportOpen(true);
            setImportMessage(null);
            fileInputRef.current?.click();
          }} title="选择蓝图文件或粘贴 JSON" aria-label="导入蓝图"><Upload size={15} /><span>导入蓝图</span></button>
        </> : null}<button className="blueprint-close" type="button" onClick={onClose} title="关闭蓝图工作区" aria-label="关闭蓝图工作区"><X size={18} /></button></div>
      </header>
      <nav className="blueprint-tabs" aria-label="蓝图视图">
        <button className={activeTab === "library" ? "active" : ""} type="button" onClick={() => setActiveTab("library")}><Layers3 size={14} />蓝图库</button>
        <button className={activeTab === "pending" ? "active" : ""} type="button" onClick={() => setActiveTab("pending")}><ListChecks size={14} />待建与补足{pendingCount > 0 ? <em>{pendingCount}</em> : null}</button>
      </nav>
      {activeTab === "library" ? <>
      <input ref={fileInputRef} className="blueprint-import-file" type="file" accept="application/json,.json" aria-label="选择要导入的蓝图文件" onChange={async (event) => { const file = event.target.files?.[0]; if (file) importRaw(await file.text()); event.target.value = ""; }} />
      {mobile && !detailBlueprintId ? <div className="mobile-blueprint-library-actions">
        <button type="button" onClick={() => {
          setImportOpen(true);
          setImportMessage(null);
          fileInputRef.current?.click();
        }} aria-label="导入蓝图"><Upload size={17} /><span>导入蓝图</span></button>
      </div> : null}
      <div className="blueprint-library-shell">
      {importOpen ? <section className="blueprint-import-panel" aria-label="蓝图导入">
        <header><div><Upload size={15} /><span><strong>导入蓝图</strong><small>交换文件会校验当前内容目录中的设备、物品和配方。</small></span></div><button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={13} />选择文件</button></header>
        <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴蓝图交换 JSON" aria-label="粘贴蓝图交换 JSON" />
        <footer><span className={importMessage?.startsWith("已导入") ? "ready" : ""}>{importMessage ?? "导出的蓝图可以直接在此粘贴。"}</span><button type="button" disabled={!importText.trim()} onClick={() => importRaw(importText)}><Check size={13} />导入到蓝图库</button></footer>
      </section> : null}
      <div className="blueprint-library">
        {game.blueprints.length === 0 ? (
          <div className="blueprint-empty"><BoxSelect size={26} /><strong>蓝图库为空</strong><span>在画布中框选设备，再使用选区复制命令建立模板。</span></div>
        ) : visibleBlueprints.map((blueprint) => {
          const requirements = getBlueprintRequirements(blueprint);
          const fleet = getBlueprintFleetLoadPreview(game, blueprint.id);
          const deployable = canPlaceBlueprint(game, blueprint.id);
          const compatible = canQueueBlueprint(game, blueprint.id);
          const recipeTemplates = blueprint.entities.filter((entity) => entity.recipeId);
          const sourceRecipeIds = [...new Set(recipeTemplates.flatMap((entity) => entity.recipeId ? [entity.recipeId] : []))];
          return (
            <article className={`blueprint-card${viewMode === "compact" && !detailBlueprintId ? " blueprint-card--compact" : ""}`} key={blueprint.id}>
              <header>
                <i><Layers3 size={18} /></i>
                <label><span>蓝图名称</span><input defaultValue={blueprint.name} aria-label={`${blueprint.name}名称`} onBlur={(event) => onRename(blueprint.id, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
                <em>{blueprint.entities.length} 设备 · {blueprint.resourceAnchors?.length ?? 0} 资源锚点 · {blueprint.belts.length} 线路 · {blueprint.externalPorts?.length ?? 0} 外部端口</em>
              </header>
              <div className="blueprint-composition">
                {blueprintBuildingSummary(blueprint).slice(0, viewMode === "compact" && !detailBlueprintId ? 3 : undefined).map((label) => <span key={label}>{label}</span>)}
                {viewMode === "compact" && blueprintBuildingSummary(blueprint).length > 3 ? <span className="blueprint-composition-more">+{blueprintBuildingSummary(blueprint).length - 3}</span> : null}
                {blueprint.entities.some((entity) => entity.buildingId === "micro_black_hole_connector" && entity.operationEnabledOnDeploy === true) ? <span className="blueprint-danger-status">部署后自动启用黑洞</span> : null}
              </div>
              {(blueprint.resourceAnchors?.length ?? 0) > 0 ? <div className="blueprint-resource-note"><strong>矿脉保持唯一</strong><span>部署时只匹配附近同类型资源点，并补齐采集设备；不会复制、移动或补充矿脉储量。</span></div> : null}
              {mobile && !detailBlueprintId ? <button className="mobile-blueprint-open" type="button" onClick={() => onMobileOpenDetail?.(`blueprint:${blueprint.id}`)}>查看与部署<ChevronRight size={18} /></button> : null}
              <div className={`blueprint-transform-controls${viewMode === "compact" && !detailBlueprintId ? " blueprint-transform-controls--compact" : ""}`}>
                <span>部署方向</span>
                <div className="segmented-control">
                  {([0, 90, 180, 270] as BlueprintRotation[]).map((rotation) => <button className={(blueprint.rotation ?? 0) === rotation ? "active" : ""} type="button" key={rotation} onClick={() => onTransform(blueprint.id, rotation, blueprint.mirror ?? "none")}><RotateCw size={12} />{rotation}°</button>)}
                </div>
                <button className={blueprint.mirror === "horizontal" ? "blueprint-mirror active" : "blueprint-mirror"} type="button" onClick={() => onTransform(blueprint.id, blueprint.rotation ?? 0, blueprint.mirror === "horizontal" ? "none" : "horizontal")}><FlipHorizontal2 size={13} />水平镜像</button>
              </div>
              {sourceRecipeIds.length > 0 ? <div className="blueprint-parameters">
                <strong>配方参数</strong>
                {sourceRecipeIds.map((sourceRecipeId) => {
                  const template = recipeTemplates.find((entity) => entity.recipeId === sourceRecipeId)!;
                  const options = getRecipesForBuilding(template.buildingId).filter((recipe) => !recipe.requiredTechId || isTechnologyCompleted(game, recipe.requiredTechId));
                  return <label key={sourceRecipeId}><span>{getRecipe(sourceRecipeId)?.name ?? sourceRecipeId}</span><select value={blueprint.recipeOverrides?.[sourceRecipeId] ?? sourceRecipeId} onChange={(event) => onRecipeOverride(blueprint.id, sourceRecipeId, event.target.value as RecipeId)}>{options.map((recipe) => <option value={recipe.id} key={recipe.id}>{recipe.name}</option>)}</select></label>;
                })}
              </div> : null}
              {(blueprint.externalPorts?.length ?? 0) > 0 ? <div className="blueprint-external-ports"><strong>外部接口</strong><div>{blueprint.externalPorts!.map((port) => <span key={port.key}>{port.direction === "input" ? "输入" : "输出"} · {getItem(port.itemId).name}</span>)}</div></div> : null}
              <div className="blueprint-requirements">
                <strong>施工需求</strong>
                <div>{requirements.map((requirement) => {
                  const stock = Math.floor(game.construction[requirement.constructionId] ?? 0);
                  return <span className={stock >= requirement.amount ? "ready" : ""} key={requirement.constructionId}>{stock >= requirement.amount ? <Check size={11} /> : <PackageOpen size={11} />}{getConstructionDefinition(requirement.constructionId)?.name ?? requirement.constructionId} {stock}/{requirement.amount}</span>;
                })}</div>
              </div>
              {fleet.drones.target > 0 || fleet.vessels.target > 0 ? <div className="blueprint-requirements blueprint-fleet-targets">
                <strong>载具目标</strong>
                <div>
                  {fleet.drones.target > 0 ? <span className={fleet.drones.shortfall === 0 ? "ready" : ""}><PackageOpen size={11} />运输机 {fleet.drones.loaded}/{fleet.drones.target}{fleet.drones.shortfall > 0 ? ` · 缺 ${fleet.drones.shortfall}` : ""}</span> : null}
                  {fleet.vessels.target > 0 ? <span className={fleet.vessels.shortfall === 0 ? "ready" : ""}><PackageOpen size={11} />运输船 {fleet.vessels.loaded}/{fleet.vessels.target}{fleet.vessels.shortfall > 0 ? ` · 缺 ${fleet.vessels.shortfall}` : ""}</span> : null}
                </div>
              </div> : null}
              <footer>
                <button className="blueprint-export" type="button" onClick={() => onExport(blueprint.id)} title={`导出${blueprint.name}`}><Download size={14} />导出</button>
                <button type="button" disabled={!compatible} onClick={() => void requestDeploy(blueprint)} title={!compatible ? "当前行星不兼容" : deployable ? `在${getPlanet(game.activePlanetId).name}部署${blueprint.name}` : "点击画布创建缺料施工订单"}>{deployable ? <Copy size={14} /> : <Clock3 size={14} />}{deployable ? "部署" : "排队部署"}</button>
                <button className="danger" type="button" onClick={() => onRemove(blueprint.id)} title={`删除${blueprint.name}`} aria-label={`删除${blueprint.name}`}><Trash2 size={14} /></button>
              </footer>
            </article>
          );
        })}
      </div>
      </div>
      </> : <section className="pending-construction-workspace" aria-label="待建与补足">
        <header>
          <div><ListChecks size={17} /><span><strong>施工订单</strong><small>按创建顺序稳定分配施工托盘与随身载具</small></span></div>
          <button type="button" disabled={pendingCount === 0} onClick={onFundAllQueues}><PackageCheck size={14} />一键补足全部</button>
        </header>
        {pendingCount === 0 ? <div className="blueprint-empty"><PackageCheck size={28} /><strong>没有待处理施工订单</strong><span>缺料蓝图会保留在画布，并在这里显示补足与取消状态。</span></div> : <div className="pending-construction-list">
          {[...game.constructionQueue].sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id)).map((entry) => {
            const details = getConstructionQueueDetails(game, entry.id);
            const constructionReady = details.status === "pending-materials" && details.requirements.every((item) => item.missing === 0);
            const constructionAvailable = details.status === "pending-materials" && details.requirements.some((item) => item.missing > 0 && item.available > 0);
            const fleetAvailable = details.fleet.some((item) => item.missing > 0 && item.available > 0);
            const canFundConstruction = details.compatible && (constructionReady || constructionAvailable);
            const canFundFleet = details.compatible && fleetAvailable;
            return <article className={`pending-construction-order pending-construction-order--${details.status}`} key={entry.id}>
              <header>
                <div><i><Layers3 size={16} /></i><span><strong>{entry.blueprintName}</strong><small>{getPlanet(entry.planetId).name} · 坐标 {Math.round(entry.position.x)}, {Math.round(entry.position.y)}</small></span></div>
                <em>{details.status === "waiting-fleet" ? "建筑完成 · 等待载具" : details.compatible ? "灰模待建" : "施工阻塞"}</em>
              </header>
              <dl className="pending-construction-meta">
                <div><dt>放置时间</dt><dd>运行 {formatSimulationTime(entry.queuedAt)}</dd></div>
                <div><dt>方向</dt><dd>{entry.rotation}°{entry.mirror === "horizontal" ? " · 水平镜像" : ""}</dd></div>
                <div><dt>版本</dt><dd>r{entry.blueprintRevision ?? details.blueprint?.revision ?? 1}</dd></div>
              </dl>
              {details.blockedReason ? <p className="pending-construction-blocked">{details.blockedReason}</p> : null}
              {details.requirements.length > 0 ? <section className="pending-construction-materials">
                <strong>建筑与线路</strong>
                <div>{details.requirements.map((item) => {
                  const exact = `${formatQuantityExact(item.reserved)} / ${formatQuantityExact(item.total)}，剩余 ${formatQuantityExact(item.missing)}，托盘可用 ${formatQuantityExact(item.available)}`;
                  return <span className={item.missing === 0 ? "ready" : ""} key={item.constructionId} title={exact}>
                    {item.missing === 0 ? <Check size={12} /> : <PackageOpen size={12} />}
                    <b>{getConstructionDefinition(item.constructionId)?.name ?? item.constructionId}</b>
                    <em>{formatQuantityCompact(item.reserved)}/{formatQuantityCompact(item.total)}</em>
                    <small>剩 {formatQuantityCompact(item.missing)} · 可用 {formatQuantityCompact(item.available)}</small>
                  </span>;
                })}</div>
              </section> : null}
              {details.fleet.length > 0 ? <section className="pending-construction-materials pending-construction-fleet">
                <strong>物流载具</strong>
                <div>{details.fleet.map((item) => {
                  const exact = `${formatQuantityExact(item.installedOrReserved)} / ${formatQuantityExact(item.total)}，剩余 ${formatQuantityExact(item.missing)}，随身可用 ${formatQuantityExact(item.available)}`;
                  return <span className={item.missing === 0 ? "ready" : ""} key={item.itemId} title={exact}>
                    {item.missing === 0 ? <Check size={12} /> : <Truck size={12} />}
                    <b>{getItem(item.itemId).name}</b>
                    <em>{formatQuantityCompact(item.installedOrReserved)}/{formatQuantityCompact(item.total)}</em>
                    <small>剩 {formatQuantityCompact(item.missing)} · 可用 {formatQuantityCompact(item.available)}</small>
                  </span>;
                })}</div>
              </section> : null}
              <footer>
                <button type="button" disabled={!canFundConstruction} onClick={() => onFundQueue(entry.id, "construction")}><PackageOpen size={14} />{constructionReady ? "开始建造" : "补足建筑与线路"}</button>
                <button type="button" disabled={!canFundFleet} onClick={() => onFundQueue(entry.id, "fleet")}><Truck size={14} />补足物流载具</button>
                <button className="primary" type="button" disabled={!details.compatible || (!canFundConstruction && !canFundFleet)} onClick={() => onFundQueue(entry.id, "all")}><PackageCheck size={14} />一键补足本订单</button>
                <button className="danger" type="button" onClick={async () => {
                  if (await gameDialog.confirm(`取消“${entry.blueprintName}”施工订单？已投入的建筑、线路和载具会完整返还。`, { danger: true, confirmLabel: "取消并返还" })) onCancelQueue(entry.id);
                }}><Trash2 size={14} />取消并返还</button>
              </footer>
            </article>;
          })}
        </div>}
      </section>}
    </section>
  );
}
