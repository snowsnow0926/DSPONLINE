import type { CanvasLineBatch } from "./canvasLineBatch";

export interface CanvasBeltHitIndex {
  batch: CanvasLineBatch;
  cellSize: number;
  buckets: ReadonlyMap<string, readonly number[]>;
  /** Packed route polylines reused by hover/double-click hit testing. */
  routeOffsets: Uint32Array;
  routeCoordinates: Float32Array;
  routeBounds: Float32Array;
}

export interface CanvasBeltHit {
  beltId: string;
  distance: number;
}

export interface CanvasBeltBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Point { x: number; y: number }

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function routePoints(batch: CanvasLineBatch, index: number): Point[] {
  const offset = index * 4;
  const source = { x: batch.positions[offset], y: batch.positions[offset + 1] };
  const target = { x: batch.positions[offset + 2], y: batch.positions[offset + 3] };
  const centerY = batch.routeCenters[index];
  if (batch.routeModes[index] !== 0 && Number.isFinite(centerY)) {
    const direction = target.x >= source.x ? 1 : -1;
    const lead = Math.min(34, Math.max(18, Math.abs(target.x - source.x) / 4));
    return [
      source,
      { x: source.x + lead * direction, y: source.y },
      { x: source.x + lead * direction, y: centerY },
      { x: target.x - lead * direction, y: centerY },
      { x: target.x - lead * direction, y: target.y },
      target,
    ];
  }
  const direction = target.x >= source.x ? 1 : -1;
  const control = Math.max(42, Math.abs(target.x - source.x) * 0.45);
  const firstControl = { x: source.x + control * direction, y: source.y };
  const secondControl = { x: target.x - control * direction, y: target.y };
  const points: Point[] = [];
  for (let step = 0; step <= 10; step += 1) {
    const t = step / 10;
    const inverse = 1 - t;
    points.push({
      x: inverse ** 3 * source.x + 3 * inverse ** 2 * t * firstControl.x + 3 * inverse * t ** 2 * secondControl.x + t ** 3 * target.x,
      y: inverse ** 3 * source.y + 3 * inverse ** 2 * t * firstControl.y + 3 * inverse * t ** 2 * secondControl.y + t ** 3 * target.y,
    });
  }
  return points;
}

function cellsForSegment(start: Point, end: Point, cellSize: number, output: Set<string>): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / cellSize));
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    output.add(cellKey(Math.floor((start.x + dx * ratio) / cellSize), Math.floor((start.y + dy * ratio) / cellSize)));
  }
}

export function buildCanvasBeltHitIndex(batch: CanvasLineBatch, requestedCellSize = 256): CanvasBeltHitIndex {
  const cellSize = Math.max(64, Math.min(1_024, Math.floor(requestedCellSize)));
  const buckets = new Map<string, number[]>();
  const routeOffsets = new Uint32Array(batch.beltIds.length + 1);
  const routeCoordinates: number[] = [];
  const routeBounds = new Float32Array(batch.beltIds.length * 4);
  for (let index = 0; index < batch.beltIds.length; index += 1) {
    const points = routePoints(batch, index);
    routeOffsets[index] = routeCoordinates.length / 2;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      routeCoordinates.push(point.x, point.y);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const boundsOffset = index * 4;
    routeBounds[boundsOffset] = minX;
    routeBounds[boundsOffset + 1] = minY;
    routeBounds[boundsOffset + 2] = maxX;
    routeBounds[boundsOffset + 3] = maxY;
    const cells = new Set<string>();
    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      cellsForSegment(points[pointIndex - 1], points[pointIndex], cellSize, cells);
    }
    for (const key of cells) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  }
  routeOffsets[batch.beltIds.length] = routeCoordinates.length / 2;
  return { batch, cellSize, buckets, routeOffsets, routeCoordinates: Float32Array.from(routeCoordinates), routeBounds };
}

/** Reuses the expensive route/bucket data for equal immutable geometry. A
 * fresh runtime/render snapshot can have different arrays with equal values.
 * Keep one index only, and bind it to the current batch for hit identities. */
export function reconcileCanvasBeltHitIndex(
  previous: CanvasBeltHitIndex | null,
  batch: CanvasLineBatch,
  requestedCellSize = 256,
): CanvasBeltHitIndex {
  const cellSize = Math.max(64, Math.min(1_024, Math.floor(requestedCellSize)));
  const source = previous?.batch;
  let equal = Boolean(previous && source && previous.cellSize === cellSize &&
    source.planetId === batch.planetId && source.segments === batch.segments &&
    source.beltIds.length === batch.beltIds.length && source.positions.length === batch.positions.length &&
    source.routeCenters.length === batch.routeCenters.length && source.routeModes.length === batch.routeModes.length);
  if (equal && source) {
    for (let i = 0; i < batch.beltIds.length && equal; i += 1) equal = source.beltIds[i] === batch.beltIds[i];
    for (let i = 0; i < batch.positions.length && equal; i += 1) equal = Object.is(source.positions[i], batch.positions[i]);
    for (let i = 0; i < batch.routeCenters.length && equal; i += 1) equal = Object.is(source.routeCenters[i], batch.routeCenters[i]);
    for (let i = 0; i < batch.routeModes.length && equal; i += 1) equal = source.routeModes[i] === batch.routeModes[i];
  }
  return equal && previous ? source === batch ? previous : { ...previous, batch }
    : buildCanvasBeltHitIndex(batch, requestedCellSize);
}

/**
 * Returns the stable batch indices whose route buckets touch a world-space
 * rectangle. Rendering can use the same topology-scoped index as hit testing
 * instead of walking every line whenever a dense canvas is zoomed.
 */
export function collectCanvasBeltIndicesInBounds(
  index: CanvasBeltHitIndex,
  bounds: CanvasBeltBounds,
  padding = 0,
): number[] {
  const normalizedPadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const left = Math.min(bounds.left, bounds.right) - normalizedPadding;
  const right = Math.max(bounds.left, bounds.right) + normalizedPadding;
  const top = Math.min(bounds.top, bounds.bottom) - normalizedPadding;
  const bottom = Math.max(bounds.top, bounds.bottom) + normalizedPadding;
  if (![left, right, top, bottom].every(Number.isFinite)) return [];
  const candidates = new Set<number>();
  const firstX = Math.floor(left / index.cellSize);
  const lastX = Math.floor(right / index.cellSize);
  const firstY = Math.floor(top / index.cellSize);
  const lastY = Math.floor(bottom / index.cellSize);
  for (let x = firstX; x <= lastX; x += 1) {
    for (let y = firstY; y <= lastY; y += 1) {
      for (const candidate of index.buckets.get(cellKey(x, y)) ?? []) candidates.add(candidate);
    }
  }
  return [...candidates].sort((leftIndex, rightIndex) => leftIndex - rightIndex);
}

export function findNearestCanvasBelt(
  index: CanvasBeltHitIndex,
  point: Point,
  maximumDistance: number,
): CanvasBeltHit | null {
  const limit = Math.max(0, maximumDistance);
  const radius = Math.max(1, Math.ceil(limit / index.cellSize));
  const centerX = Math.floor(point.x / index.cellSize);
  const centerY = Math.floor(point.y / index.cellSize);
  const candidates = new Set<number>();
  for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (const candidate of index.buckets.get(cellKey(x, y)) ?? []) candidates.add(candidate);
    }
  }
  let nearest: CanvasBeltHit | null = null;
  for (const candidate of candidates) {
    const boundsOffset = candidate * 4;
    const minX = index.routeBounds[boundsOffset];
    const minY = index.routeBounds[boundsOffset + 1];
    const maxX = index.routeBounds[boundsOffset + 2];
    const maxY = index.routeBounds[boundsOffset + 3];
    const dx = point.x < minX ? minX - point.x : point.x > maxX ? point.x - maxX : 0;
    const dy = point.y < minY ? minY - point.y : point.y > maxY ? point.y - maxY : 0;
    if (Math.hypot(dx, dy) > limit) continue;
    const firstPoint = index.routeOffsets[candidate];
    const endPoint = index.routeOffsets[candidate + 1];
    let distance = Number.POSITIVE_INFINITY;
    for (let pointIndex = firstPoint + 1; pointIndex < endPoint; pointIndex += 1) {
      const startOffset = (pointIndex - 1) * 2;
      const endOffset = pointIndex * 2;
      distance = Math.min(distance, distanceToSegment(point,
        { x: index.routeCoordinates[startOffset], y: index.routeCoordinates[startOffset + 1] },
        { x: index.routeCoordinates[endOffset], y: index.routeCoordinates[endOffset + 1] }));
    }
    if (distance <= limit && (!nearest || distance < nearest.distance ||
      (distance === nearest.distance && index.batch.beltIds[candidate].localeCompare(nearest.beltId) < 0))) {
      nearest = { beltId: index.batch.beltIds[candidate], distance };
    }
  }
  return nearest;
}
