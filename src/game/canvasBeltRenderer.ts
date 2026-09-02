import type { CanvasViewport } from "./types";

export const CANVAS_BELT_OVERSCAN = 384;
export const CANVAS_BELT_OFFSCREEN_THRESHOLD = 2_048;
export const CANVAS_BELT_RENDER_PROTOCOL_VERSION = 1;

export interface CanvasBeltRenderGeometry {
  positions: Float32Array;
  routeCenters: Float32Array;
  routeModes: Uint8Array;
  colors: readonly string[];
}

export interface CanvasBeltRenderSurface {
  width: number;
  height: number;
  dpr: number;
  overscan: number;
}

export interface CanvasBeltRenderResult {
  candidateSegments: number;
  drawnSegments: number;
}

export interface CanvasBeltTimingSummary {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  longTaskCount: number;
}

export type CanvasBeltRenderLayer = "topology" | "telemetry";

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function finiteIntensity(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return 0;
  return Math.min(1, value ?? 0);
}

function traceBeltPath(
  context: DrawingContext,
  geometry: CanvasBeltRenderGeometry,
  index: number,
  viewport: CanvasViewport,
  surface: CanvasBeltRenderSurface,
  margin: number,
): boolean {
  const offset = index * 4;
  if (offset + 3 >= geometry.positions.length || index >= geometry.routeModes.length ||
      index >= geometry.routeCenters.length) return false;
  const sourceX = surface.overscan + viewport.x + geometry.positions[offset] * viewport.zoom;
  const sourceY = surface.overscan + viewport.y + geometry.positions[offset + 1] * viewport.zoom;
  const targetX = surface.overscan + viewport.x + geometry.positions[offset + 2] * viewport.zoom;
  const targetY = surface.overscan + viewport.y + geometry.positions[offset + 3] * viewport.zoom;
  const center = geometry.routeCenters[index];
  const centerY = geometry.routeModes[index] === 0 || !Number.isFinite(center)
    ? (sourceY + targetY) / 2
    : surface.overscan + viewport.y + center * viewport.zoom;
  const surfaceWidth = surface.width + surface.overscan * 2;
  const surfaceHeight = surface.height + surface.overscan * 2;
  if (Math.max(sourceX, targetX) < -margin || Math.min(sourceX, targetX) > surfaceWidth + margin ||
      Math.max(sourceY, targetY, centerY) < -margin ||
      Math.min(sourceY, targetY, centerY) > surfaceHeight + margin) return false;
  context.moveTo(sourceX, sourceY);
  if (geometry.routeModes[index] === 0) {
    const control = Math.max(42, Math.abs(targetX - sourceX) * 0.45);
    const direction = targetX >= sourceX ? 1 : -1;
    context.bezierCurveTo(
      sourceX + control * direction,
      sourceY,
      targetX - control * direction,
      targetY,
      targetX,
      targetY,
    );
    return true;
  }
  const direction = targetX >= sourceX ? 1 : -1;
  const lead = Math.min(34 * viewport.zoom, Math.max(12, Math.abs(targetX - sourceX) / 4));
  context.lineTo(sourceX + lead * direction, sourceY);
  context.lineTo(sourceX + lead * direction, centerY);
  context.lineTo(targetX - lead * direction, centerY);
  context.lineTo(targetX - lead * direction, targetY);
  context.lineTo(targetX, targetY);
  return true;
}

export function configureCanvasBeltSurface(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  context: DrawingContext,
  surface: CanvasBeltRenderSurface,
): void {
  const surfaceWidth = surface.width + surface.overscan * 2;
  const surfaceHeight = surface.height + surface.overscan * 2;
  const pixelWidth = Math.ceil(surfaceWidth * surface.dpr);
  const pixelHeight = Math.ceil(surfaceHeight * surface.dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
  context.clearRect(0, 0, surfaceWidth, surfaceHeight);
}

/**
 * Paints either immutable topology or the small dynamic telemetry/selection
 * overlay. The topology layer never depends on runtime flow or selection, so
 * a simulation revision cannot force the large geometry surface to repaint.
 */
export function paintCanvasBeltLayer(
  context: DrawingContext,
  geometry: CanvasBeltRenderGeometry,
  candidateIndexes: Uint32Array,
  viewport: CanvasViewport,
  surface: CanvasBeltRenderSurface,
  layer: CanvasBeltRenderLayer,
  selected?: Uint8Array,
  flowIntensity?: Float32Array,
): CanvasBeltRenderResult {
  const groups = new Map<string, {
    color: string;
    alpha: number;
    width: number;
    indexes: number[];
  }>();
  for (const index of candidateIndexes) {
    if (index >= geometry.colors.length) continue;
    let color = geometry.colors[index] ?? "#6da8a0";
    let alpha = 0.68;
    let width = 1.5;
    if (layer === "telemetry") {
      if (selected?.[index] === 1) {
        color = "#f3d27b";
        alpha = 0.98;
        width = 3;
      } else {
        const intensity = finiteIntensity(flowIntensity?.[index]);
        if (intensity <= 0) continue;
        alpha = 0.18 + intensity * 0.54;
        width = 0.75 + intensity * 1.25;
      }
    }
    const key = `${color}|${alpha.toFixed(3)}|${width.toFixed(3)}`;
    const group = groups.get(key) ?? { color, alpha, width, indexes: [] };
    group.indexes.push(index);
    groups.set(key, group);
  }
  let drawnSegments = 0;
  for (const group of groups.values()) {
    context.strokeStyle = group.color;
    context.globalAlpha = group.alpha;
    context.lineWidth = group.width;
    context.beginPath();
    let visiblePaths = 0;
    for (const index of group.indexes) {
      if (!traceBeltPath(context, geometry, index, viewport, surface, 96)) continue;
      visiblePaths += 1;
      drawnSegments += 1;
    }
    if (visiblePaths > 0) context.stroke();
  }
  context.globalAlpha = 1;
  return { candidateSegments: candidateIndexes.length, drawnSegments };
}

export interface CanvasBeltWorkerInitMessage {
  kind: "init";
  protocolVersion: typeof CANVAS_BELT_RENDER_PROTOCOL_VERSION;
  canvas: OffscreenCanvas;
}

export interface CanvasBeltWorkerTopologyMessage {
  kind: "topology";
  protocolVersion: typeof CANVAS_BELT_RENDER_PROTOCOL_VERSION;
  revision: number;
  positions: Float32Array;
  routeCenters: Float32Array;
  routeModes: Uint8Array;
  colors: string[];
}

export interface CanvasBeltWorkerFrameMessage {
  kind: "frame";
  protocolVersion: typeof CANVAS_BELT_RENDER_PROTOCOL_VERSION;
  sequence: number;
  revision: number;
  viewport: CanvasViewport;
  surface: CanvasBeltRenderSurface;
  candidateIndexes: Uint32Array;
}

export type CanvasBeltWorkerRequest =
  | CanvasBeltWorkerInitMessage
  | CanvasBeltWorkerTopologyMessage
  | CanvasBeltWorkerFrameMessage;

export type CanvasBeltWorkerResponse = {
  kind: "frame-complete";
  protocolVersion: typeof CANVAS_BELT_RENDER_PROTOCOL_VERSION;
  sequence: number;
  revision: number;
  durationMs: number;
  candidateSegments: number;
  drawnSegments: number;
} | {
  kind: "unavailable";
  protocolVersion: typeof CANVAS_BELT_RENDER_PROTOCOL_VERSION;
  code: "CONTEXT_UNAVAILABLE" | "CONTEXT_LOST" | "PROTOCOL_INVALID";
};

export function normalizeCanvasBeltDpr(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(1.25, value)) : 1;
}

export function summarizeCanvasBeltTimings(samples: readonly number[]): CanvasBeltTimingSummary {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0).slice(-120);
  if (valid.length === 0) {
    return { sampleCount: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, longTaskCount: 0 };
  }
  const ordered = [...valid].sort((left, right) => left - right);
  const at = (fraction: number) => ordered[Math.min(
    ordered.length - 1,
    Math.floor((ordered.length - 1) * fraction),
  )];
  return {
    sampleCount: ordered.length,
    p50Ms: at(0.50),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: ordered[ordered.length - 1],
    longTaskCount: ordered.filter((value) => value > 50).length,
  };
}
