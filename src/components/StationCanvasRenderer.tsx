import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type OnNodeDrag,
  type Viewport,
} from "@xyflow/react";
import { Box, ClipboardList, RadioTower, Satellite, ShoppingBag, Sparkles } from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import { getStationDecoration, getStationLevel, getStationTheme } from "../game/stationDecorations";
import type { OrbitalStationState, StationDecorationPlacement } from "../game/types";
import "../styles/station.css";

export interface StationCanvasState {
  status: OrbitalStationState["status"];
  viewport: OrbitalStationState["viewport"];
  economy: Pick<OrbitalStationState["economy"], "stationReputation">;
  layout: Pick<OrbitalStationState["layout"], "themeId" | "placements">;
}

interface StationCanvasRendererProps {
  station: StationCanvasState;
  readOnly?: boolean;
  selectedPlacementId?: string | null;
  onSelectPlacement?: (placementId: string | null) => void;
  onMovePlacement?: (placementId: string, position: { x: number; y: number }) => void;
  onViewportChange?: (viewport: Viewport) => void;
  className?: string;
}

const STATUS_INDEX: Record<OrbitalStationState["status"], number> = {
  locked: 0,
  eligible: 1,
  "core-building": 2,
  "dock-building": 3,
  "showcase-building": 4,
  operational: 5,
};

// React Flow treats `edges` as a controlled collection. Passing a fresh `[]`
// on every render makes StoreUpdater publish another store update, which can
// recurse until React trips its maximum-update-depth guard when the workspace
// itself reacts to a viewport or selection change.
const EMPTY_STATION_EDGES: Edge[] = [];

const FUNCTIONAL_MODULES = [
  { id: "core", label: "轨道核心", subtitle: "全星系设施控制", x: -400, y: -170, width: 260, height: 180, required: 2, icon: <Satellite size={24} /> },
  { id: "dock", label: "物资出口港", subtitle: "建设与货运终端", x: -45, y: -245, width: 250, height: 150, required: 3, icon: <Box size={24} /> },
  { id: "contracts", label: "合同终端", subtitle: "每日出口舱单", x: 155, y: 5, width: 230, height: 150, required: 4, icon: <ClipboardList size={24} /> },
  { id: "shop", label: "装饰商店", subtitle: "轨道徽记收藏", x: -135, y: 120, width: 250, height: 140, required: 5, icon: <ShoppingBag size={24} /> },
  { id: "showcase", label: "纪念展柜", subtitle: "奖杯与成就陈列", x: -470, y: 130, width: 210, height: 130, required: 5, icon: <Sparkles size={24} /> },
  { id: "beacon", label: "公共通讯信标", subtitle: "公开主页与预设信号", x: 300, y: -240, width: 220, height: 130, required: 5, icon: <RadioTower size={24} /> },
] as const;

function placementNode(placement: StationDecorationPlacement, selected: boolean, readOnly: boolean): Node {
  const definition = getStationDecoration(placement.decorationId);
  const width = definition?.width ?? 72;
  const height = definition?.height ?? 72;
  const swapped = placement.rotation === 90 || placement.rotation === 270;
  const renderedWidth = swapped ? height : width;
  const renderedHeight = swapped ? width : height;
  return {
    id: `decor:${placement.id}`,
    type: "default",
    position: { x: placement.x - renderedWidth / 2, y: placement.y - renderedHeight / 2 },
    data: {
      label: <div
        className="station-decoration-node__body"
        title={definition?.description ?? "未知内容包装饰"}
        style={{ transform: `rotate(${placement.rotation}deg)` }}
      >
        <i style={{ color: definition?.color }}>{definition?.glyph ?? "?"}</i>
        <span>{definition?.name ?? placement.decorationId}</span>
      </div>,
    },
    draggable: !readOnly,
    selectable: true,
    selected,
    width: renderedWidth,
    height: renderedHeight,
    style: {
      width: renderedWidth,
      height: renderedHeight,
      zIndex: 20 + placement.layer,
    },
    className: `station-decoration-node station-decoration-node--layer-${placement.layer}${selected ? " station-decoration-node--selected" : ""}`,
    ariaLabel: `${definition?.name ?? placement.decorationId}${readOnly ? "，只读展示" : "，可移动装饰"}`,
  };
}

export function StationCanvasRenderer({
  station,
  readOnly = false,
  selectedPlacementId = null,
  onSelectPlacement,
  onMovePlacement,
  onViewportChange,
  className = "",
}: StationCanvasRendererProps) {
  const level = getStationLevel(station.economy.stationReputation);
  const theme = getStationTheme(station.layout.themeId);
  const nodes = useMemo<Node[]>(() => {
    const statusIndex = STATUS_INDEX[station.status];
    const modules = FUNCTIONAL_MODULES.map((module): Node => ({
      id: `module:${module.id}`,
      type: "default",
      position: { x: module.x, y: module.y },
      data: { label: <div className="station-module-node__body">{module.icon}<span><strong>{module.label}</strong><small>{statusIndex >= module.required ? module.subtitle : "施工灰模 · 尚未开放"}</small></span></div> },
      draggable: false,
      selectable: false,
      width: module.width,
      height: module.height,
      style: { width: module.width, height: module.height, zIndex: 10 },
      className: `station-module-node${statusIndex >= module.required ? " station-module-node--online" : " station-module-node--ghost"}`,
      ariaLabel: `${module.label}，${statusIndex >= module.required ? "已开放" : "尚未开放"}`,
    }));
    return [
      ...modules,
      ...station.layout.placements
        .slice()
        .sort((left, right) => left.layer - right.layer || left.id.localeCompare(right.id))
        .map((placement) => placementNode(placement, placement.id === selectedPlacementId, readOnly)),
    ];
  }, [readOnly, selectedPlacementId, station.layout.placements, station.status]);

  const handleDragStop: OnNodeDrag = (_event, node) => {
    if (readOnly || !node.id.startsWith("decor:")) return;
    const placementId = node.id.slice("decor:".length);
    const placement = station.layout.placements.find((candidate) => candidate.id === placementId);
    const definition = placement ? getStationDecoration(placement.decorationId) : undefined;
    if (!placement || !definition) return;
    const swapped = placement.rotation === 90 || placement.rotation === 270;
    onMovePlacement?.(placementId, {
      x: Math.round(node.position.x + (swapped ? definition.height : definition.width) / 2),
      y: Math.round(node.position.y + (swapped ? definition.width : definition.height) / 2),
    });
  };

  // App already lives under the factory ReactFlowProvider. A second ReactFlow
  // without its own provider would overwrite that store while the station is
  // open and reset it on unmount, leaving the factory visible but unable to
  // drag, box-select, connect, or translate placement coordinates.
  return <ReactFlowProvider>
    <section
      className={`station-canvas-renderer${readOnly ? " station-canvas-renderer--readonly" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--station-canvas-background": theme?.background, "--station-canvas-accent": theme?.accent } as CSSProperties}
      aria-label={readOnly ? "只读空间站展示画布" : "空间站装饰画布"}
    >
      <ReactFlow
        id="orbital-station-flow"
        nodes={nodes}
        edges={EMPTY_STATION_EDGES}
        defaultViewport={station.viewport}
        minZoom={0.2}
        maxZoom={2.5}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => onSelectPlacement?.(node.id.startsWith("decor:") ? node.id.slice("decor:".length) : null)}
        onPaneClick={() => onSelectPlacement?.(null)}
        onNodeDragStop={handleDragStop}
        onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--station-canvas-accent)" />
        <Controls showInteractive={!readOnly} />
        <MiniMap pannable={!readOnly} zoomable={!readOnly} nodeColor={(node) => node.id.startsWith("module:") ? "var(--station-canvas-accent)" : "#c58b51"} />
      </ReactFlow>
      <div className="station-canvas-level" aria-label={`空间站等级 ${level.level}`}><strong>Lv.{level.level}</strong><span>{level.title}</span><small>{station.layout.placements.length}/{level.placementLimit} 装饰</small></div>
    </section>
  </ReactFlowProvider>;
}
