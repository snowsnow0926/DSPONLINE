import { getCanvasLod, type CanvasLod } from "./canvasPerformance";

export const CONNECTION_VIEWPORT_ENTER_OVERSCAN_PX = 300;
export const CONNECTION_VIEWPORT_EXIT_OVERSCAN_PX = 380;
export const CONNECTION_NODE_FALLBACK_WIDTH = 360;
export const CONNECTION_NODE_FALLBACK_HEIGHT = 260;

export interface CanvasViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasViewportSize {
  width: number;
  height: number;
}

export interface CanvasWorldRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ConnectionViewportBounds {
  enter: CanvasWorldRectangle;
  exit: CanvasWorldRectangle;
}

export interface CanvasNodeRectangle {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface NodeConnectionPresentationInput {
  connectionActive: boolean;
  expandAll: boolean;
  source: boolean;
  selected: boolean;
  candidate: boolean;
  viewport: boolean;
  preserveFullDetail: boolean;
  blockingInteraction: boolean;
  denseNodeLodActive: boolean;
  zoom: number;
}

export interface NodeConnectionPresentation {
  lod: CanvasLod;
  full: boolean;
  exposeConnectionDraft: boolean;
  reason: "expand-all" | "source" | "selected" | "candidate" | "viewport" | "preserved" | "ordinary" | null;
}

export interface NodeConnectionDraftToken {
  nodeId: string;
  handleId: string;
  itemId: string | null;
  handleType: "source" | "target";
}

export interface LatestFramePublisher<T> {
  push(value: T): void;
  cancel(): void;
  pending(): boolean;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function getCanvasWorldRectangle(
  viewport: CanvasViewportTransform,
  size: CanvasViewportSize,
  overscanPx = 0,
): CanvasWorldRectangle {
  const zoom = Math.max(0.01, finiteOr(viewport.zoom, 1));
  const x = finiteOr(viewport.x, 0);
  const y = finiteOr(viewport.y, 0);
  const width = Math.max(0, finiteOr(size.width, 0));
  const height = Math.max(0, finiteOr(size.height, 0));
  const overscan = Math.max(0, finiteOr(overscanPx, 0));
  return {
    left: (-x - overscan) / zoom,
    top: (-y - overscan) / zoom,
    right: (width - x + overscan) / zoom,
    bottom: (height - y + overscan) / zoom,
  };
}

export function getConnectionViewportBounds(
  viewport: CanvasViewportTransform,
  size: CanvasViewportSize,
): ConnectionViewportBounds {
  return {
    enter: getCanvasWorldRectangle(viewport, size, CONNECTION_VIEWPORT_ENTER_OVERSCAN_PX),
    exit: getCanvasWorldRectangle(viewport, size, CONNECTION_VIEWPORT_EXIT_OVERSCAN_PX),
  };
}

export function connectionViewportBoundsEqual(
  left: ConnectionViewportBounds,
  right: ConnectionViewportBounds,
  tolerance = 0.01,
): boolean {
  return (["left", "top", "right", "bottom"] as const).every((key) =>
    Math.abs(left.enter[key] - right.enter[key]) <= tolerance &&
    Math.abs(left.exit[key] - right.exit[key]) <= tolerance);
}

function rectangleIntersects(left: CanvasWorldRectangle, right: CanvasWorldRectangle): boolean {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

export function nodeIsInsideConnectionViewport(
  node: CanvasNodeRectangle,
  bounds: ConnectionViewportBounds,
  wasInside: boolean,
): boolean {
  const width = Math.max(1, finiteOr(node.width ?? CONNECTION_NODE_FALLBACK_WIDTH, CONNECTION_NODE_FALLBACK_WIDTH));
  const height = Math.max(1, finiteOr(node.height ?? CONNECTION_NODE_FALLBACK_HEIGHT, CONNECTION_NODE_FALLBACK_HEIGHT));
  const x = finiteOr(node.x, 0);
  const y = finiteOr(node.y, 0);
  return rectangleIntersects({ left: x, top: y, right: x + width, bottom: y + height }, wasInside ? bounds.exit : bounds.enter);
}

function reducedLod(zoom: number): CanvasLod {
  const zoomLod = getCanvasLod(zoom);
  return zoomLod === "full" ? "medium" : zoomLod;
}

export function resolveNodeConnectionPresentation(input: NodeConnectionPresentationInput): NodeConnectionPresentation {
  if (!input.connectionActive) {
    const full = input.selected || input.preserveFullDetail || input.blockingInteraction || !input.denseNodeLodActive;
    return {
      lod: full ? "full" : reducedLod(input.zoom),
      full,
      exposeConnectionDraft: false,
      reason: full ? "ordinary" : null,
    };
  }

  const reason = input.expandAll
    ? "expand-all"
    : input.source
      ? "source"
      : input.selected
        ? "selected"
        : input.candidate
          ? "candidate"
          : input.viewport
            ? "viewport"
            : input.preserveFullDetail || input.blockingInteraction
              ? "preserved"
              : null;
  const full = reason !== null;
  return {
    lod: full ? "full" : reducedLod(input.zoom),
    full,
    exposeConnectionDraft: full,
    reason,
  };
}

export function getNodeConnectionPresentationToken(
  draft: NodeConnectionDraftToken | null,
  nodeId: string,
  expose: boolean,
): string {
  if (!draft || !expose) return "connection:none";
  const role = draft.nodeId === nodeId ? "origin" : "context";
  return `connection:${role}:${draft.handleType}:${draft.handleId}:${draft.itemId ?? "*"}`;
}

/**
 * Coalesces an arbitrary number of viewport updates into one publication on
 * the next animation frame. The most recent transform always wins.
 */
export function createLatestFramePublisher<T>(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
  publish: (value: T) => void,
): LatestFramePublisher<T> {
  let frame: number | null = null;
  let latest: T | undefined;
  return {
    push(value) {
      latest = value;
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        const next = latest;
        latest = undefined;
        if (next !== undefined) publish(next);
      });
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      latest = undefined;
    },
    pending() {
      return frame !== null;
    },
  };
}
