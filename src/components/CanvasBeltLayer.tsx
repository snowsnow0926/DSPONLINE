import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { ITEMS } from "../game/content";
import { buildCanvasLineBatchFromGeometry, type CanvasLineNodeGeometry } from "../game/canvasLineBatch";
import { buildCanvasBeltHitIndex, findNearestCanvasBelt, type CanvasBeltHit } from "../game/canvasBeltSpatialIndex";
import type { BeltConnection, CanvasViewport, PlanetId } from "../game/types";

const CANVAS_PAN_OVERSCAN = 384;

interface CanvasBeltLayerProps {
  belts: readonly BeltConnection[];
  nodes: readonly CanvasLineNodeGeometry[];
  routeCenters: ReadonlyMap<string, number | undefined>;
  topologyRevision: number;
  planetId: PlanetId;
  viewport: CanvasViewport;
  width: number;
  height: number;
  selectedBeltIds: ReadonlySet<string>;
  onUnavailable: () => void;
}

export interface CanvasBeltLayerHandle {
  setViewport: (viewport: CanvasViewport) => void;
  findNearestBelt: (point: { x: number; y: number }, maximumDistance: number) => CanvasBeltHit | null;
}

/** Dense renderer with its own spatial hit index; detailed React Flow edges are promoted by the parent on demand. */
export const CanvasBeltLayer = forwardRef<CanvasBeltLayerHandle, CanvasBeltLayerProps>(function CanvasBeltLayer({ belts, nodes, routeCenters, topologyRevision, planetId, viewport, width, height, selectedBeltIds, onUnavailable }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef(viewport);
  const drawnViewportRef = useRef(viewport);
  const drawFrameRef = useRef<number | null>(null);
  const drawCountRef = useRef(0);
  const drawTotalMsRef = useRef(0);
  // Runtime belt observations do not change geometry. Repack only on an
  // explicit topology/geometry revision so hover and production refreshes do
  // not rebuild a multi-thousand-line spatial index.
  const batch = useMemo(() => buildCanvasLineBatchFromGeometry(belts, planetId, nodes, routeCenters), [nodes, planetId, routeCenters, topologyRevision]);
  const hitIndex = useMemo(() => buildCanvasBeltHitIndex(batch), [batch]);
  // Item/color belongs to topology. Runtime flow refreshes replace the belts
  // array frequently, but must not rebuild the full visual map or hit layer.
  const beltItemById = useMemo(() => new Map(belts.map((belt) => [belt.id, belt.itemId])), [planetId, topologyRevision]);
  const lineGroups = useMemo(() => {
    const groups = new Map<string, { color: string; selected: boolean; indexes: number[] }>();
    for (let index = 0; index < batch.beltIds.length; index += 1) {
      const beltId = batch.beltIds[index];
      const itemId = beltItemById.get(beltId);
      if (!itemId) continue;
      const selected = selectedBeltIds.has(beltId);
      const color = selected ? "#f3d27b" : ITEMS[itemId]?.color ?? "#6da8a0";
      const key = `${selected ? 1 : 0}|${color}`;
      const group = groups.get(key) ?? { color, selected, indexes: [] };
      group.indexes.push(index);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [batch.beltIds, beltItemById, selectedBeltIds]);

  const draw = useCallback(() => {
    drawFrameRef.current = null;
    const startedAt = performance.now();
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = Math.max(1, Math.min(1.25, window.devicePixelRatio || 1));
    const surfaceWidth = width + CANVAS_PAN_OVERSCAN * 2;
    const surfaceHeight = height + CANVAS_PAN_OVERSCAN * 2;
    const pixelWidth = Math.ceil(surfaceWidth * dpr);
    const pixelHeight = Math.ceil(surfaceHeight * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    if (canvas.style.width !== `${surfaceWidth}px`) canvas.style.width = `${surfaceWidth}px`;
    if (canvas.style.height !== `${surfaceHeight}px`) canvas.style.height = `${surfaceHeight}px`;
    if (canvas.style.left !== `${-CANVAS_PAN_OVERSCAN}px`) canvas.style.left = `${-CANVAS_PAN_OVERSCAN}px`;
    if (canvas.style.top !== `${-CANVAS_PAN_OVERSCAN}px`) canvas.style.top = `${-CANVAS_PAN_OVERSCAN}px`;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext("2d"); } catch { onUnavailable(); return; }
    if (!context) { onUnavailable(); return; }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, surfaceWidth, surfaceHeight);
    const currentViewport = viewportRef.current;
    drawnViewportRef.current = currentViewport;
    canvas.style.transform = "translate3d(0, 0, 0)";
    const margin = 96;
    for (const group of lineGroups) {
      context.strokeStyle = group.color;
      context.globalAlpha = group.selected ? 0.95 : 0.68;
      context.lineWidth = group.selected ? 3 : 1.5;
      context.beginPath();
      let visiblePaths = 0;
      for (const index of group.indexes) {
        const offset = index * 4;
        const sourceX = CANVAS_PAN_OVERSCAN + currentViewport.x + batch.positions[offset] * currentViewport.zoom;
        const sourceY = CANVAS_PAN_OVERSCAN + currentViewport.y + batch.positions[offset + 1] * currentViewport.zoom;
        const targetX = CANVAS_PAN_OVERSCAN + currentViewport.x + batch.positions[offset + 2] * currentViewport.zoom;
        const targetY = CANVAS_PAN_OVERSCAN + currentViewport.y + batch.positions[offset + 3] * currentViewport.zoom;
        const center = batch.routeCenters[index];
        const centerY = batch.routeModes[index] === 0 || !Number.isFinite(center)
          ? (sourceY + targetY) / 2
          : CANVAS_PAN_OVERSCAN + currentViewport.y + center * currentViewport.zoom;
        if (Math.max(sourceX, targetX) < -margin || Math.min(sourceX, targetX) > surfaceWidth + margin ||
          Math.max(sourceY, targetY, centerY) < -margin || Math.min(sourceY, targetY, centerY) > surfaceHeight + margin) continue;
        visiblePaths += 1;
        context.moveTo(sourceX, sourceY);
        if (batch.routeModes[index] === 0) {
          const control = Math.max(42, Math.abs(targetX - sourceX) * 0.45);
          const direction = targetX >= sourceX ? 1 : -1;
          context.bezierCurveTo(sourceX + control * direction, sourceY, targetX - control * direction, targetY, targetX, targetY);
          continue;
        }
        const direction = targetX >= sourceX ? 1 : -1;
        const lead = Math.min(34 * currentViewport.zoom, Math.max(12, Math.abs(targetX - sourceX) / 4));
        context.lineTo(sourceX + lead * direction, sourceY);
        context.lineTo(sourceX + lead * direction, centerY);
        context.lineTo(targetX - lead * direction, centerY);
        context.lineTo(targetX - lead * direction, targetY);
        context.lineTo(targetX, targetY);
      }
      if (visiblePaths > 0) context.stroke();
    }
    context.globalAlpha = 1;
    const durationMs = performance.now() - startedAt;
    drawCountRef.current += 1;
    drawTotalMsRef.current += durationMs;
    canvas.dataset.drawCount = String(drawCountRef.current);
    canvas.dataset.drawTotalMs = drawTotalMsRef.current.toFixed(3);
    canvas.dataset.lastDrawMs = durationMs.toFixed(3);
  }, [batch, height, lineGroups, onUnavailable, width]);

  const scheduleDraw = useCallback(() => {
    if (drawFrameRef.current != null) return;
    drawFrameRef.current = window.requestAnimationFrame(draw);
  }, [draw]);

  const updateViewport = useCallback((nextViewport: CanvasViewport) => {
    viewportRef.current = nextViewport;
    const drawn = drawnViewportRef.current;
    if (Math.abs(nextViewport.zoom - drawn.zoom) > 0.0001) {
      scheduleDraw();
      return;
    }
    const offsetX = nextViewport.x - drawn.x;
    const offsetY = nextViewport.y - drawn.y;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;
    if (Math.abs(offsetX) >= CANVAS_PAN_OVERSCAN || Math.abs(offsetY) >= CANVAS_PAN_OVERSCAN) scheduleDraw();
  }, [scheduleDraw]);

  useImperativeHandle(ref, () => ({
    setViewport(nextViewport) {
      updateViewport(nextViewport);
    },
    findNearestBelt(point, maximumDistance) {
      return findNearestCanvasBelt(hitIndex, point, maximumDistance);
    },
  }), [hitIndex, updateViewport]);

  useEffect(() => {
    updateViewport(viewport);
  }, [updateViewport, viewport]);
  useEffect(() => scheduleDraw(), [scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleContextLoss = () => onUnavailable();
    canvas.addEventListener("contextlost", handleContextLoss, { once: true });
    return () => {
      canvas.removeEventListener("contextlost", handleContextLoss);
      if (drawFrameRef.current != null) window.cancelAnimationFrame(drawFrameRef.current);
      drawFrameRef.current = null;
    };
  }, [onUnavailable]);

  return <canvas ref={canvasRef} className="canvas-belt-layer" aria-hidden="true" data-segments={batch.segments} />;
});
