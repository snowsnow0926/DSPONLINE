import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { ITEMS } from "../game/content";
import {
  buildCanvasLineBatchFromGeometry,
  type CanvasLineBelt,
  type CanvasLineEndpoint,
  type CanvasLineNodeGeometry,
} from "../game/canvasLineBatch";
import {
  buildCanvasBeltHitIndex,
  collectCanvasBeltIndicesInBounds,
  findNearestCanvasBelt,
  type CanvasBeltHit,
} from "../game/canvasBeltSpatialIndex";
import {
  CANVAS_BELT_OFFSCREEN_THRESHOLD,
  CANVAS_BELT_OVERSCAN,
  CANVAS_BELT_RENDER_PROTOCOL_VERSION,
  configureCanvasBeltSurface,
  normalizeCanvasBeltDpr,
  paintCanvasBeltLayer,
  summarizeCanvasBeltTimings,
  type CanvasBeltRenderGeometry,
  type CanvasBeltRenderSurface,
  type CanvasBeltWorkerFrameMessage,
  type CanvasBeltWorkerResponse,
} from "../game/canvasBeltRenderer";
import type { CanvasViewport, PlanetId } from "../game/types";

const EMPTY_HIDDEN_BELTS = new Set<string>();
const EMPTY_FLOW_ACTIVITY = new Map<string, number>();

interface CanvasBeltLayerProps {
  belts: readonly CanvasLineBelt[];
  nodes: readonly CanvasLineNodeGeometry[];
  endpoints: ReadonlyMap<string, CanvasLineEndpoint>;
  routeCenters: ReadonlyMap<string, number | undefined>;
  topologyRevision: number;
  planetId: PlanetId;
  viewport: CanvasViewport;
  width: number;
  height: number;
  selectedBeltIds: ReadonlySet<string>;
  flowActivityByBeltId?: ReadonlyMap<string, number>;
  onUnavailable: () => void;
}

export interface CanvasBeltLayerHandle {
  setViewport: (viewport: CanvasViewport) => void;
  findNearestBelt: (point: { x: number; y: number }, maximumDistance: number) => CanvasBeltHit | null;
}

type BaseRendererMode = "uninitialized" | "main-thread" | "offscreen-worker";

function applyCanvasSurfaceStyle(canvas: HTMLCanvasElement, surface: CanvasBeltRenderSurface): void {
  const surfaceWidth = surface.width + surface.overscan * 2;
  const surfaceHeight = surface.height + surface.overscan * 2;
  if (canvas.style.width !== `${surfaceWidth}px`) canvas.style.width = `${surfaceWidth}px`;
  if (canvas.style.height !== `${surfaceHeight}px`) canvas.style.height = `${surfaceHeight}px`;
  if (canvas.style.left !== `${-surface.overscan}px`) canvas.style.left = `${-surface.overscan}px`;
  if (canvas.style.top !== `${-surface.overscan}px`) canvas.style.top = `${-surface.overscan}px`;
}

function normalizeFlowIntensity(flow: number | undefined): number {
  if (!Number.isFinite(flow) || (flow ?? 0) <= 0) return 0;
  return Math.min(1, Math.log2((flow ?? 0) + 1) / 8);
}

/**
 * Immutable topology is painted on a base surface (OffscreenCanvas for dense
 * factories); live flow and selection are painted on a separate cheap layer.
 * Both layers are display caches and never own or mutate gameplay state.
 */
export const CanvasBeltLayer = forwardRef<CanvasBeltLayerHandle, CanvasBeltLayerProps>(function CanvasBeltLayer({
  belts,
  nodes,
  endpoints,
  routeCenters,
  topologyRevision,
  planetId,
  viewport,
  width,
  height,
  selectedBeltIds,
  flowActivityByBeltId = EMPTY_FLOW_ACTIVITY,
  onUnavailable,
}, ref) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef(viewport);
  const drawnViewportRef = useRef(viewport);
  const baseDrawFrameRef = useRef<number | null>(null);
  const overlayDrawFrameRef = useRef<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerTopologyRevisionRef = useRef<number | null>(null);
  const workerSequenceRef = useRef(0);
  const workerFrameInFlightRef = useRef(false);
  const workerPendingFrameRef = useRef<CanvasBeltWorkerFrameMessage | null>(null);
  const topologyRevisionRef = useRef(topologyRevision);
  const baseRendererModeRef = useRef<BaseRendererMode>("uninitialized");
  const onUnavailableRef = useRef(onUnavailable);
  const drawCountRef = useRef(0);
  const drawTotalMsRef = useRef(0);
  const drawMaxMsRef = useRef(0);
  const baseTimingSamplesRef = useRef<number[]>([]);
  const overlayTimingSamplesRef = useRef<number[]>([]);
  onUnavailableRef.current = onUnavailable;
  topologyRevisionRef.current = topologyRevision;

  // Runtime observations do not change geometry. Repack only on an explicit
  // topology revision so telemetry cannot rebuild the large hit index.
  const batch = useMemo(() => buildCanvasLineBatchFromGeometry(
    belts,
    planetId,
    nodes,
    routeCenters,
    EMPTY_HIDDEN_BELTS,
    endpoints,
  ), [belts, endpoints, nodes, planetId, routeCenters, topologyRevision]);
  const hitIndex = useMemo(() => buildCanvasBeltHitIndex(batch), [batch]);
  const beltItemById = useMemo(
    () => new Map(belts.map((belt) => [belt.id, belt.itemId])),
    [planetId, topologyRevision],
  );
  const geometry = useMemo<CanvasBeltRenderGeometry>(() => ({
    positions: batch.positions,
    routeCenters: batch.routeCenters,
    routeModes: batch.routeModes,
    colors: batch.beltIds.map((beltId) => {
      const itemId = beltItemById.get(beltId);
      return itemId ? ITEMS[itemId]?.color ?? "#6da8a0" : "#6da8a0";
    }),
  }), [batch, beltItemById]);
  const selectedFlags = useMemo(() => Uint8Array.from(
    batch.beltIds,
    (beltId) => selectedBeltIds.has(beltId) ? 1 : 0,
  ), [batch.beltIds, selectedBeltIds]);
  const flowIntensity = useMemo(() => Float32Array.from(
    batch.beltIds,
    (beltId) => normalizeFlowIntensity(flowActivityByBeltId.get(beltId)),
  ), [batch.beltIds, flowActivityByBeltId]);

  const surface = useCallback((): CanvasBeltRenderSurface => ({
    width,
    height,
    dpr: normalizeCanvasBeltDpr(window.devicePixelRatio || 1),
    overscan: CANVAS_BELT_OVERSCAN,
  }), [height, width]);

  const visibleCandidateIndexes = useCallback((currentViewport: CanvasViewport): Uint32Array => {
    const currentSurface = surface();
    const margin = 96;
    const zoom = Math.max(0.01, currentViewport.zoom);
    return Uint32Array.from(collectCanvasBeltIndicesInBounds(hitIndex, {
      left: (-margin - currentSurface.overscan - currentViewport.x) / zoom,
      top: (-margin - currentSurface.overscan - currentViewport.y) / zoom,
      right: (currentSurface.width + currentSurface.overscan + margin - currentViewport.x) / zoom,
      bottom: (currentSurface.height + currentSurface.overscan + margin - currentViewport.y) / zoom,
    }, hitIndex.cellSize));
  }, [hitIndex, surface]);

  const failRenderer = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    workerTopologyRevisionRef.current = null;
    workerFrameInFlightRef.current = false;
    workerPendingFrameRef.current = null;
    onUnavailableRef.current();
  }, []);

  const publishTiming = useCallback((canvas: HTMLCanvasElement, samples: number[], durationMs: number) => {
    samples.push(Math.max(0, durationMs));
    if (samples.length > 120) samples.splice(0, samples.length - 120);
    const timing = summarizeCanvasBeltTimings(samples);
    canvas.dataset.sampleCount = String(timing.sampleCount);
    canvas.dataset.p50Ms = timing.p50Ms.toFixed(3);
    canvas.dataset.p95Ms = timing.p95Ms.toFixed(3);
    canvas.dataset.p99Ms = timing.p99Ms.toFixed(3);
    canvas.dataset.maxMs = timing.maxMs.toFixed(3);
    canvas.dataset.longTaskCount = String(timing.longTaskCount);
  }, []);

  const dispatchWorkerFrame = useCallback((worker: Worker, frame: CanvasBeltWorkerFrameMessage) => {
    workerFrameInFlightRef.current = true;
    worker.postMessage(frame, [frame.candidateIndexes.buffer]);
  }, []);

  const ensureBaseRenderer = useCallback((): BaseRendererMode => {
    if (baseRendererModeRef.current !== "uninitialized") return baseRendererModeRef.current;
    const canvas = baseCanvasRef.current;
    const supportsWorker = batch.segments >= CANVAS_BELT_OFFSCREEN_THRESHOLD &&
      typeof Worker !== "undefined" && typeof canvas?.transferControlToOffscreen === "function";
    if (!canvas || !supportsWorker) {
      baseRendererModeRef.current = "main-thread";
      if (canvas) canvas.dataset.renderer = "main-thread";
      return baseRendererModeRef.current;
    }
    try {
      const offscreen = canvas.transferControlToOffscreen();
      const worker = new Worker(new URL("../game/canvasBeltRender.worker.ts", import.meta.url), {
        type: "module",
        name: "canvas-belt-topology-renderer",
      });
      worker.onmessage = (event: MessageEvent<CanvasBeltWorkerResponse>) => {
        const message = event.data;
        if (!message || message.protocolVersion !== CANVAS_BELT_RENDER_PROTOCOL_VERSION ||
            message.kind === "unavailable") {
          failRenderer();
          return;
        }
        if (message.kind !== "frame-complete") {
          failRenderer();
          return;
        }
        const current = baseCanvasRef.current;
        if (current && message.revision === topologyRevisionRef.current) {
          drawCountRef.current += 1;
          drawTotalMsRef.current += message.durationMs;
          drawMaxMsRef.current = Math.max(drawMaxMsRef.current, message.durationMs);
          current.dataset.drawCount = String(drawCountRef.current);
          current.dataset.drawTotalMs = drawTotalMsRef.current.toFixed(3);
          current.dataset.drawMaxMs = drawMaxMsRef.current.toFixed(3);
          current.dataset.lastDrawMs = message.durationMs.toFixed(3);
          current.dataset.candidateSegments = String(message.candidateSegments);
          current.dataset.drawnSegments = String(message.drawnSegments);
          publishTiming(current, baseTimingSamplesRef.current, message.durationMs);
        }
        workerFrameInFlightRef.current = false;
        const pending = workerPendingFrameRef.current;
        workerPendingFrameRef.current = null;
        if (pending && workerRef.current === worker) dispatchWorkerFrame(worker, pending);
      };
      worker.onerror = failRenderer;
      worker.postMessage({
        kind: "init",
        protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION,
        canvas: offscreen,
      }, [offscreen]);
      workerRef.current = worker;
      baseRendererModeRef.current = "offscreen-worker";
      canvas.dataset.renderer = "offscreen-worker";
    } catch {
      // A browser/RDP policy change can make OffscreenCanvas unavailable.
      // Falling back only changes display caches, never the authority state.
      baseRendererModeRef.current = "offscreen-worker";
      failRenderer();
    }
    return baseRendererModeRef.current;
  }, [batch.segments, dispatchWorkerFrame, failRenderer, publishTiming]);

  const publishWorkerTopology = useCallback((worker: Worker) => {
    if (workerTopologyRevisionRef.current === topologyRevision) return;
    const positions = geometry.positions.slice();
    const routeCentersCopy = geometry.routeCenters.slice();
    const routeModesCopy = geometry.routeModes.slice();
    worker.postMessage({
      kind: "topology",
      protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION,
      revision: topologyRevision,
      positions,
      routeCenters: routeCentersCopy,
      routeModes: routeModesCopy,
      colors: [...geometry.colors],
    }, [positions.buffer, routeCentersCopy.buffer, routeModesCopy.buffer]);
    workerTopologyRevisionRef.current = topologyRevision;
  }, [geometry, topologyRevision]);

  const drawBase = useCallback(() => {
    baseDrawFrameRef.current = null;
    const canvas = baseCanvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const currentSurface = surface();
    applyCanvasSurfaceStyle(canvas, currentSurface);
    const currentViewport = viewportRef.current;
    drawnViewportRef.current = currentViewport;
    canvas.dataset.drawnViewportX = currentViewport.x.toFixed(4);
    canvas.dataset.drawnViewportY = currentViewport.y.toFixed(4);
    canvas.dataset.drawnViewportZoom = currentViewport.zoom.toFixed(6);
    canvas.dataset.overscan = String(currentSurface.overscan);
    canvas.style.transform = "translate3d(0, 0, 0)";
    const candidateIndexes = visibleCandidateIndexes(currentViewport);
    if (ensureBaseRenderer() === "offscreen-worker") {
      const worker = workerRef.current;
      if (!worker) return;
      publishWorkerTopology(worker);
      const frame: CanvasBeltWorkerFrameMessage = {
        kind: "frame",
        protocolVersion: CANVAS_BELT_RENDER_PROTOCOL_VERSION,
        sequence: ++workerSequenceRef.current,
        revision: topologyRevision,
        viewport: currentViewport,
        surface: currentSurface,
        candidateIndexes,
      };
      if (workerFrameInFlightRef.current) workerPendingFrameRef.current = frame;
      else dispatchWorkerFrame(worker, frame);
      return;
    }
    const startedAt = performance.now();
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext("2d"); } catch { failRenderer(); return; }
    if (!context) { failRenderer(); return; }
    configureCanvasBeltSurface(canvas, context, currentSurface);
    const result = paintCanvasBeltLayer(
      context,
      geometry,
      candidateIndexes,
      currentViewport,
      currentSurface,
      "topology",
    );
    const durationMs = performance.now() - startedAt;
    drawCountRef.current += 1;
    drawTotalMsRef.current += durationMs;
    drawMaxMsRef.current = Math.max(drawMaxMsRef.current, durationMs);
    canvas.dataset.drawCount = String(drawCountRef.current);
    canvas.dataset.drawTotalMs = drawTotalMsRef.current.toFixed(3);
    canvas.dataset.drawMaxMs = drawMaxMsRef.current.toFixed(3);
    canvas.dataset.lastDrawMs = durationMs.toFixed(3);
    canvas.dataset.candidateSegments = String(result.candidateSegments);
    canvas.dataset.drawnSegments = String(result.drawnSegments);
    publishTiming(canvas, baseTimingSamplesRef.current, durationMs);
  }, [dispatchWorkerFrame, ensureBaseRenderer, failRenderer, geometry, height, publishTiming, publishWorkerTopology, surface, topologyRevision, visibleCandidateIndexes, width]);

  const drawOverlay = useCallback(() => {
    overlayDrawFrameRef.current = null;
    const canvas = overlayCanvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const currentSurface = surface();
    applyCanvasSurfaceStyle(canvas, currentSurface);
    canvas.style.transform = "translate3d(0, 0, 0)";
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext("2d"); } catch { failRenderer(); return; }
    if (!context) { failRenderer(); return; }
    const startedAt = performance.now();
    configureCanvasBeltSurface(canvas, context, currentSurface);
    const currentViewport = viewportRef.current;
    const result = paintCanvasBeltLayer(
      context,
      geometry,
      visibleCandidateIndexes(currentViewport),
      currentViewport,
      currentSurface,
      "telemetry",
      selectedFlags,
      flowIntensity,
    );
    canvas.dataset.candidateSegments = String(result.candidateSegments);
    canvas.dataset.drawnSegments = String(result.drawnSegments);
    publishTiming(canvas, overlayTimingSamplesRef.current, performance.now() - startedAt);
  }, [failRenderer, flowIntensity, geometry, height, publishTiming, selectedFlags, surface, visibleCandidateIndexes, width]);

  const scheduleBaseDraw = useCallback(() => {
    if (baseDrawFrameRef.current != null) return;
    baseDrawFrameRef.current = window.requestAnimationFrame(drawBase);
  }, [drawBase]);
  const scheduleOverlayDraw = useCallback(() => {
    if (overlayDrawFrameRef.current != null) return;
    overlayDrawFrameRef.current = window.requestAnimationFrame(drawOverlay);
  }, [drawOverlay]);

  const updateViewport = useCallback((nextViewport: CanvasViewport) => {
    viewportRef.current = nextViewport;
    const drawn = drawnViewportRef.current;
    if (Math.abs(nextViewport.zoom - drawn.zoom) > 0.0001) {
      scheduleBaseDraw();
      scheduleOverlayDraw();
      return;
    }
    const offsetX = nextViewport.x - drawn.x;
    const offsetY = nextViewport.y - drawn.y;
    for (const canvas of [baseCanvasRef.current, overlayCanvasRef.current]) {
      if (canvas) canvas.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;
    }
    if (Math.abs(offsetX) >= CANVAS_BELT_OVERSCAN || Math.abs(offsetY) >= CANVAS_BELT_OVERSCAN) {
      scheduleBaseDraw();
      scheduleOverlayDraw();
    }
  }, [scheduleBaseDraw, scheduleOverlayDraw]);

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
  useEffect(() => scheduleBaseDraw(), [scheduleBaseDraw]);
  useEffect(() => scheduleOverlayDraw(), [scheduleOverlayDraw]);

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!baseCanvas || !overlayCanvas) return;
    const handleContextLoss = () => failRenderer();
    baseCanvas.addEventListener("contextlost", handleContextLoss, { once: true });
    overlayCanvas.addEventListener("contextlost", handleContextLoss, { once: true });
    return () => {
      baseCanvas.removeEventListener("contextlost", handleContextLoss);
      overlayCanvas.removeEventListener("contextlost", handleContextLoss);
      if (baseDrawFrameRef.current != null) window.cancelAnimationFrame(baseDrawFrameRef.current);
      if (overlayDrawFrameRef.current != null) window.cancelAnimationFrame(overlayDrawFrameRef.current);
      baseDrawFrameRef.current = null;
      overlayDrawFrameRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      workerTopologyRevisionRef.current = null;
      workerFrameInFlightRef.current = false;
      workerPendingFrameRef.current = null;
    };
  }, [failRenderer]);

  return <div
    className="canvas-belt-layer"
    aria-hidden="true"
    data-segments={batch.segments}
    data-topology-revision={topologyRevision}
    data-static-dynamic-split="true"
    data-first-source-x={batch.segments > 0 ? batch.positions[0] : undefined}
    data-first-source-y={batch.segments > 0 ? batch.positions[1] : undefined}
    data-first-target-x={batch.segments > 0 ? batch.positions[2] : undefined}
    data-first-target-y={batch.segments > 0 ? batch.positions[3] : undefined}
    data-first-route-mode={batch.segments > 0 ? batch.routeModes[0] : undefined}
    data-first-route-center={batch.segments > 0 && Number.isFinite(batch.routeCenters[0]) ? batch.routeCenters[0] : undefined}
  >
    <canvas ref={baseCanvasRef} className="canvas-belt-layer__topology" />
    <canvas ref={overlayCanvasRef} className="canvas-belt-layer__telemetry" />
  </div>;
});
