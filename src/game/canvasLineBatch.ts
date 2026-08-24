import type { BeltConnection, FactoryEntity, GameState, PlanetId } from "./types";

export interface CanvasLineBatch {
  planetId: PlanetId;
  beltIds: string[];
  positions: Float32Array;
  routeCenters: Float32Array;
  routeModes: Uint8Array;
  segments: number;
}

export interface CanvasLineNodeGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A belt endpoint measured from React Flow's internal handle geometry.
 *
 * Dense Canvas rendering used to infer both endpoints from the card centre.
 * That is only correct for a single-port card: multi-input/output cards place
 * handles at different vertical offsets, so the inferred line visibly misses
 * the port (and can appear to jump when the card changes LOD).  Keep this
 * structure in world coordinates so the renderer can apply the same viewport
 * transform as React Flow without reading DOM pixels during a draw.
 */
export interface CanvasLineEndpoint {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

/**
 * Immutable belt topology consumed by the dense renderer. Runtime flow
 * counters intentionally stay out of this shape so a simulation tick cannot
 * invalidate the packed geometry or hit index.
 */
export interface CanvasLineBelt {
  id: string;
  planetId: PlanetId;
  source: string;
  target: string;
  itemId: BeltConnection["itemId"];
  tier: BeltConnection["tier"];
  lanes: number;
  stackSize?: BeltConnection["stackSize"];
  priority: BeltConnection["priority"];
  targetPortIndex?: BeltConnection["targetPortIndex"];
  routeMode?: BeltConnection["routeMode"];
  routeOffsetY?: BeltConnection["routeOffsetY"];
}

/**
 * Benchmark/experimental renderer input. It intentionally does not replace
 * React Flow: selection and hit testing still use the existing belt objects.
 * The packed positions let a future Canvas/WebGL layer draw all visible lines
 * without allocating one React edge object per line.
 */
export function buildCanvasLineBatch(
  state: Pick<GameState, "entities" | "belts">,
  planetId: PlanetId,
  bounds?: { left: number; top: number; right: number; bottom: number },
): CanvasLineBatch {
  const entities = new Map<string, FactoryEntity>(state.entities.filter((entity) => entity.planetId === planetId).map((entity) => [entity.id, entity]));
  const beltIds: string[] = [];
  const positions: number[] = [];
  const visible = (x: number, y: number) => !bounds || (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
  for (const belt of state.belts) {
    if (belt.planetId !== planetId) continue;
    const source = entities.get(belt.source);
    const target = entities.get(belt.target);
    if (!source || !target) continue;
    const sourceX = source.position.x;
    const sourceY = source.position.y;
    const targetX = target.position.x;
    const targetY = target.position.y;
    if (!visible(Math.max(sourceX, targetX), Math.max(sourceY, targetY)) &&
      !visible(Math.min(sourceX, targetX), Math.min(sourceY, targetY))) continue;
    beltIds.push(belt.id);
    positions.push(sourceX, sourceY, targetX, targetY);
  }
  return {
    planetId,
    beltIds,
    positions: Float32Array.from(positions),
    routeCenters: new Float32Array(beltIds.length).fill(Number.NaN),
    routeModes: new Uint8Array(beltIds.length),
    segments: beltIds.length,
  };
}

/** Builds routed endpoints from the already-mounted React Flow geometry. */
export function buildCanvasLineBatchFromGeometry(
  belts: readonly CanvasLineBelt[],
  planetId: PlanetId,
  nodes: readonly CanvasLineNodeGeometry[],
  routeCenters: ReadonlyMap<string, number | undefined>,
  hiddenBeltIds: ReadonlySet<string> = new Set(),
  endpoints: ReadonlyMap<string, CanvasLineEndpoint> = new Map(),
): CanvasLineBatch {
  const geometryById = new Map(nodes.map((node) => [node.id, node]));
  const beltIds: string[] = [];
  const positions: number[] = [];
  const centers: number[] = [];
  const modes: number[] = [];
  for (const belt of belts) {
    if (belt.planetId !== planetId || hiddenBeltIds.has(belt.id)) continue;
    const source = geometryById.get(belt.source);
    const target = geometryById.get(belt.target);
    if (!source || !target) continue;
    beltIds.push(belt.id);
    const measured = endpoints.get(belt.id);
    positions.push(
      measured?.sourceX ?? source.x + source.width,
      measured?.sourceY ?? source.y + source.height / 2,
      measured?.targetX ?? target.x,
      measured?.targetY ?? target.y + target.height / 2,
    );
    centers.push(routeCenters.get(belt.id) ?? Number.NaN);
    modes.push((belt.routeMode ?? "auto") === "bezier" ? 0 : 1);
  }
  return {
    planetId,
    beltIds,
    positions: Float32Array.from(positions),
    routeCenters: Float32Array.from(centers),
    routeModes: Uint8Array.from(modes),
    segments: beltIds.length,
  };
}

export function canvasLineBatchBytes(batch: CanvasLineBatch): number {
  return batch.positions.byteLength + batch.routeCenters.byteLength + batch.routeModes.byteLength +
    batch.beltIds.reduce((total, id) => total + id.length * 2, 0);
}

export function canvasLineBatchIncludes(batch: CanvasLineBatch, belt: BeltConnection): boolean {
  return batch.beltIds.includes(belt.id);
}
