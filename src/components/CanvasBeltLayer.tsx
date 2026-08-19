import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { ITEMS } from "../game/content";
import { buildCanvasLineBatchFromGeometry, type CanvasLineNodeGeometry } from "../game/canvasLineBatch";
import { buildCanvasBeltHitIndex, collectCanvasBeltIndicesInBounds, findNearestCanvasBelt, type CanvasBeltHit } from "../game/canvasBeltSpatialIndex";
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
  const drawMaxMsRef = useRef(0);
  // Runtime belt observations do not change geometry. Repack only on an
  // explicit topology/geometry revision so hover and production refreshes do
  // not rebuild a multi-thousand-line spatial index.
  const batch = useMemo(() => buildCanvasLineBatchFromGeometry(belts, planetId, nodes, routeCenters), [nodes, planetId, routeCenters, topologyRevision]);
  const hitIndex = useMemo(() => buildCanvasBeltHitIndex(batch), [batch]);
  // Item/color belongs to topology. Runtime flow refreshes replace the belts
  // array frequently, but must not rebuild the full visual map or hit layer.
  const beltItemById = useMemo(() => new Map(belts.map((belt) => [belt.id, belt.itemId])), [planetId, topologyRevision]);
  const lineStyleByIndex = useMemo(() => batch.beltIds.map((beltId) => {
    const itemId = beltItemById.get(beltId);
    if (!itemId) return null;
    const selected = selectedBeltIds.has(beltId);
    const color = selected ? "#f3d27b" : ITEMS[itemId]?.color ?? "#6da8a0";
    return { key: `${selected ? 1 : 0}|${color}`, color, selected };
  }), [batch.beltIds, beltItemById, selectedBeltIds]);

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
    canvas.dataset.drawnViewportX = String(currentViewport.x);
    canvas.dataset.drawnViewportY = String(currentViewport.y);
    canvas.dataset.drawnViewportZoom = String(currentViewport.zoom);
    const margin = 96;
    const zoom = Math.max(0.01, currentViewport.zoom);
    // The hit index records the full route geometry in world coordinates.
    // Reuse it here so zoom redraws examine only lines around this Canvas
    // surface rather than every dense-factory belt. One cell of padding keeps
    // the sampled bezier buckets conservative at the visible boundary.
    const candidateIndexes = collectCanvasBeltIndicesInBounds(hitIndex, {
      left: (-margin - CANVAS_PAN_OVERSCAN - currentViewport.x) / zoom,
      top: (-margin - CANVAS_PAN_OVERSCAN - currentViewport.y) / zoom,
      right: (surfaceWidth + margin - CANVAS_PAN_OVERSCAN - currentViewport.x) / zoom,
      bottom: (surfaceHeight + margin - CANVAS_PAN_OVERSCAN - currentViewport.y) / zoom,
    }, hitIndex.cellSize);
    const groups = new Map<string, { color: string; selected: boolean; indexes: number[] }>();
    for (const index of candidateIndexes) {
      const style = lineStyleByIndex[index];
      if (!style) continue;
      const group = groups.get(style.key) ?? { color: style.color, selected: style.selected, indexes: [] };
      group.indexes.push(index);
      groups.set(style.key, group);
    }
    let drawnSegments = 0;
    for (const group of groups.values()) {
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
        drawnSegments += 1;
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
    drawMaxMsRef.current = Math.max(drawMaxMsRef.current, durationMs);
    canvas.dataset.drawCount = String(drawCountRef.current);
    canvas.dataset.drawTotalMs = drawTotalMsRef.current.toFixed(3);
    canvas.dataset.drawMaxMs = drawMaxMsRef.current.toFixed(3);
    canvas.dataset.lastDrawMs = durationMs.toFixed(3);
    canvas.dataset.candidateSegments = String(candidateIndexes.length);
    canvas.dataset.drawnSegments = String(drawnSegments);
  }, [batch, height, hitIndex, lineStyleByIndex, onUnavailable, width]);

  const scheduleDraw = useCallback(() => {
    if (drawFrameRef.current != null) return;
    drawFrameRef.current = window.requestAnimationFrame(draw);
  }, [draw]);

  const updateViewport = useCallback((nextViewport: CanvasViewport) => {
    viewportRef.current = nextViewport;
    const drawn = drawnViewportRef.current;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.dataset.liveViewportX = String(nextViewport.x);
      canvas.dataset.liveViewportY = String(nextViewport.y);
      canvas.dataset.liveViewportZoom = String(nextViewport.zoom);
    }
    if (Math.abs(nextViewport.zoom - drawn.zoom) > 0.0001) {
      scheduleDraw();
      return;
    }
    const offsetX = nextViewport.x - drawn.x;
    const offsetY = nextViewport.y - drawn.y;
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

  const updateViewportRef = useRef(updateViewport);
  updateViewportRef.current = updateViewport;
  useEffect(() => {
    // Live panning is intentionally imperative. A topology or selection
    // rerender can replace `updateViewport` while the controlled prop still
    // contains the last published/programmatic viewport. Reapplying that
    // stale prop snaps only the Canvas belts back and detaches them from the
    // React Flow nodes. Synchronize only when the prop coordinates themselves
    // change; imperative setViewport remains authoritative between publishes.
    updateViewportRef.current(viewport);
  }, [viewport.x, viewport.y, viewport.zoom]);
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

  return <canvas
    ref={canvasRef}
    className="canvas-belt-layer"
    aria-hidden="true"
    data-segments={batch.segments}
    data-first-source-x={batch.segments > 0 ? batch.positions[0] : undefined}
    data-first-source-y={batch.segments > 0 ? batch.positions[1] : undefined}
    data-first-target-x={batch.segments > 0 ? batch.positions[2] : undefined}
    data-first-target-y={batch.segments > 0 ? batch.positions[3] : undefined}
    data-first-route-mode={batch.segments > 0 ? batch.routeModes[0] : undefined}
    data-first-route-center={batch.segments > 0 && Number.isFinite(batch.routeCenters[0]) ? batch.routeCenters[0] : undefined}
  />;
});
