import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { CanvasEntityTopology } from "../game/canvasTopology";
import type { CanvasViewport } from "../game/types";

type CanvasMiniMapNode = Pick<CanvasEntityTopology, "id" | "kind" | "x" | "y">;

interface CanvasMiniMapProps {
  nodes: readonly CanvasMiniMapNode[];
  worldBounds?: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
  projectionSource?: "web-game-state" | "native-core";
  projectionRevision?: number | null;
  planetEntityCount?: number;
  planetBeltCount?: number;
  viewport: CanvasViewport;
  canvasWidth: number;
  canvasHeight: number;
  lightTheme: boolean;
  onCenter: (x: number, y: number) => void;
  onZoom: (direction: 1 | -1) => void;
  onUnavailable: () => void;
}

export interface CanvasMiniMapHandle {
  setViewport: (viewport: CanvasViewport) => void;
}

interface MiniMapProjection {
  minX: number;
  minY: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 150;
const MINIMAP_PADDING = 10;
const MINIMAP_GESTURE_FRAME_MS = 80;
const NODE_WIDTH = 256;
const NODE_HEIGHT = 180;

function nodeColor(kind: CanvasMiniMapNode["kind"]): string {
  if (kind === "vein") return "#79a27f";
  if (kind === "power") return "#e1b452";
  if (kind === "station") return "#d8794d";
  if (kind === "storage") return "#8aa69d";
  if (kind === "splitter") return "#d2aa5b";
  return "#61a9a4";
}

export function projectCanvasMiniMap(
  nodes: readonly CanvasMiniMapNode[],
  viewport: CanvasViewport,
  canvasWidth: number,
  canvasHeight: number,
  worldBounds?: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
): MiniMapProjection {
  const visibleLeft = -viewport.x / Math.max(0.01, viewport.zoom);
  const visibleTop = -viewport.y / Math.max(0.01, viewport.zoom);
  const visibleRight = visibleLeft + canvasWidth / Math.max(0.01, viewport.zoom);
  const visibleBottom = visibleTop + canvasHeight / Math.max(0.01, viewport.zoom);
  let minX = visibleLeft;
  let minY = visibleTop;
  let maxX = visibleRight;
  let maxY = visibleBottom;
  if (worldBounds) {
    minX = Math.min(minX, worldBounds.minX);
    minY = Math.min(minY, worldBounds.minY);
    maxX = Math.max(maxX, worldBounds.maxX + NODE_WIDTH);
    maxY = Math.max(maxY, worldBounds.maxY + NODE_HEIGHT);
  } else {
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.y + NODE_HEIGHT);
    }
  }
  const worldWidth = Math.max(1, maxX - minX);
  const worldHeight = Math.max(1, maxY - minY);
  const scale = Math.min(
    (MINIMAP_WIDTH - MINIMAP_PADDING * 2) / worldWidth,
    (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / worldHeight,
  );
  return {
    minX,
    minY,
    scale,
    offsetX: (MINIMAP_WIDTH - worldWidth * scale) / 2,
    offsetY: (MINIMAP_HEIGHT - worldHeight * scale) / 2,
  };
}

/** Extreme-mode minimap that redraws only from the low-frequency topology snapshot. */
export const CanvasMiniMap = memo(forwardRef<CanvasMiniMapHandle, CanvasMiniMapProps>(function CanvasMiniMap({
  nodes,
  worldBounds,
  projectionSource,
  projectionRevision,
  planetEntityCount,
  planetBeltCount,
  viewport,
  canvasWidth,
  canvasHeight,
  lightTheme,
  onCenter,
  onZoom,
  onUnavailable,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const drawCountRef = useRef(0);
  const viewportRef = useRef(viewport);
  const projectionRef = useRef(projectCanvasMiniMap(nodes, viewport, canvasWidth, canvasHeight, worldBounds));
  const drawFrameRef = useRef<number | null>(null);
  const drawTimerRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(0);

  const draw = useCallback(() => {
    drawFrameRef.current = null;
    lastDrawAtRef.current = performance.now();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentViewport = viewportRef.current;
    const projection = projectCanvasMiniMap(nodes, currentViewport, canvasWidth, canvasHeight, worldBounds);
    projectionRef.current = projection;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.ceil(MINIMAP_WIDTH * dpr);
    canvas.height = Math.ceil(MINIMAP_HEIGHT * dpr);
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext("2d"); } catch { onUnavailable(); return; }
    if (!context) { onUnavailable(); return; }
    canvas.dataset.drawCount = String(++drawCountRef.current);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
    context.fillStyle = lightTheme ? "#eef4f0" : "#0f1513";
    context.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

    for (const node of nodes) {
      const x = projection.offsetX + (node.x - projection.minX) * projection.scale;
      const y = projection.offsetY + (node.y - projection.minY) * projection.scale;
      context.globalAlpha = 0.9;
      context.fillStyle = nodeColor(node.kind);
      context.fillRect(x, y, Math.max(2, NODE_WIDTH * projection.scale), Math.max(2, NODE_HEIGHT * projection.scale));
    }

    const zoom = Math.max(0.01, currentViewport.zoom);
    const visibleLeft = -currentViewport.x / zoom;
    const visibleTop = -currentViewport.y / zoom;
    context.globalAlpha = 1;
    context.fillStyle = lightTheme ? "rgba(97, 169, 164, 0.12)" : "rgba(98, 181, 174, 0.14)";
    context.strokeStyle = lightTheme ? "#28746f" : "#78d0c8";
    context.lineWidth = 1.5;
    const maskX = projection.offsetX + (visibleLeft - projection.minX) * projection.scale;
    const maskY = projection.offsetY + (visibleTop - projection.minY) * projection.scale;
    const maskWidth = canvasWidth / zoom * projection.scale;
    const maskHeight = canvasHeight / zoom * projection.scale;
    context.fillRect(maskX, maskY, maskWidth, maskHeight);
    context.strokeRect(maskX, maskY, maskWidth, maskHeight);
  }, [canvasHeight, canvasWidth, lightTheme, nodes, onUnavailable, worldBounds]);

  const scheduleDraw = useCallback(() => {
    if (drawFrameRef.current != null || drawTimerRef.current != null) return;
    const remaining = MINIMAP_GESTURE_FRAME_MS - (performance.now() - lastDrawAtRef.current);
    if (remaining <= 0) {
      drawFrameRef.current = window.requestAnimationFrame(draw);
      return;
    }
    drawTimerRef.current = window.setTimeout(() => {
      drawTimerRef.current = null;
      drawFrameRef.current = window.requestAnimationFrame(draw);
    }, remaining);
  }, [draw]);

  useImperativeHandle(ref, () => ({
    setViewport(nextViewport) {
      viewportRef.current = nextViewport;
      scheduleDraw();
    },
  }), [scheduleDraw]);

  useEffect(() => {
    viewportRef.current = viewport;
    // Declarative changes are infrequent (planet/size/topology switches) and
    // should finish before the component is considered settled. Gesture-end
    // updates use the imperative RAF path below, so a delayed initial frame
    // cannot be mistaken for a redraw during an active pan.
    if (drawFrameRef.current != null) window.cancelAnimationFrame(drawFrameRef.current);
    if (drawTimerRef.current != null) window.clearTimeout(drawTimerRef.current);
    drawFrameRef.current = null;
    drawTimerRef.current = null;
    draw();
  }, [draw, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleContextLoss = () => onUnavailable();
    canvas.addEventListener("contextlost", handleContextLoss, { once: true });
    return () => {
      canvas.removeEventListener("contextlost", handleContextLoss);
      if (drawFrameRef.current != null) window.cancelAnimationFrame(drawFrameRef.current);
      if (drawTimerRef.current != null) window.clearTimeout(drawTimerRef.current);
      drawFrameRef.current = null;
      drawTimerRef.current = null;
    };
  }, [onUnavailable]);

  const centerAtPointer = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const miniX = (clientX - bounds.left) * MINIMAP_WIDTH / Math.max(1, bounds.width);
    const miniY = (clientY - bounds.top) * MINIMAP_HEIGHT / Math.max(1, bounds.height);
    const current = projectionRef.current;
    onCenter(
      current.minX + (miniX - current.offsetX) / Math.max(0.0001, current.scale),
      current.minY + (miniY - current.offsetY) / Math.max(0.0001, current.scale),
    );
  };

  return <div
    className="react-flow__panel bottom right react-flow__minimap canvas-minimap-snapshot nodrag nopan"
    data-snapshot-nodes={nodes.length}
    data-projection-source={projectionSource ?? "web-game-state"}
    data-projection-revision={projectionRevision ?? ""}
    data-planet-entity-count={planetEntityCount ?? nodes.length}
    data-planet-belt-count={planetBeltCount ?? ""}
  >
    <canvas
      ref={canvasRef}
      width={MINIMAP_WIDTH}
      height={MINIMAP_HEIGHT}
      aria-label="低频画布小地图"
      role="img"
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        centerAtPointer(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        centerAtPointer(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerCancel={() => { draggingRef.current = false; }}
      onWheel={(event) => {
        onZoom(event.deltaY < 0 ? 1 : -1);
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  </div>;
}));
