import type { BeltConnection, BeltInputPortIndex, BuildingId, EntityKind, FactoryEntity, ItemId, PlanetId } from "./types";
import type { BeltBundleInfo, PortOccupancy } from "./network";

export interface CanvasEntityTopology {
  id: string;
  kind: EntityKind;
  /** Stable building identity used to resolve special React Flow ports. */
  buildingId?: BuildingId;
  x: number;
  y: number;
}

export type CanvasBeltTopology = Pick<BeltConnection,
  "id" | "source" | "target" | "itemId" | "tier" | "lanes" | "stackSize" |
  "priority" | "targetPortIndex" | "routeMode" | "routeOffsetY"> & {
  planetId: PlanetId;
};

export interface FactoryCanvasTopology {
  planetId: PlanetId;
  revision: number;
  signature: string;
  entities: readonly CanvasEntityTopology[];
  belts: readonly CanvasBeltTopology[];
  connectedInputsByTarget: ReadonlyMap<string, readonly ItemId[]>;
  targetPortItemsByEntity: ReadonlyMap<string, Readonly<Partial<Record<BeltInputPortIndex, ItemId>>>>;
  occupancy: PortOccupancy;
  bundleByBeltId: ReadonlyMap<string, BeltBundleInfo>;
}

export interface CanvasNodeRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function topologySignature(
  planetId: PlanetId,
  entities: readonly FactoryEntity[],
  belts: readonly BeltConnection[],
): string {
  const entityPart = entities.map((entity) =>
    `${entity.id}:${entity.kind}:${entity.position.x}:${entity.position.y}`).join(";");
  const beltPart = belts.map((belt) => [
    belt.id,
    belt.source,
    belt.target,
    belt.itemId,
    belt.tier,
    belt.lanes,
    belt.stackSize ?? 1,
    belt.priority,
    belt.targetPortIndex ?? "",
    belt.routeMode ?? "auto",
    belt.routeOffsetY ?? 0,
  ].join(":")).join(";");
  return `${planetId}|${entityPart}|${beltPart}`;
}

export function reconcileFactoryCanvasTopology(
  previous: FactoryCanvasTopology | null,
  planetId: PlanetId,
  entities: readonly FactoryEntity[],
  belts: readonly BeltConnection[],
  topologyRevision?: number,
): FactoryCanvasTopology {
  if (topologyRevision !== undefined && previous?.planetId === planetId && previous.revision === topologyRevision) return previous;
  const signature = topologySignature(planetId, entities, belts);
  if (topologyRevision === undefined && previous?.signature === signature) return previous;

  const connectedInputsByTarget = new Map<string, ItemId[]>();
  const targetPortItemsByEntity = new Map<string, Partial<Record<BeltInputPortIndex, ItemId>>>();
  const input = new Map<string, Partial<Record<ItemId, number>>>();
  const output = new Map<string, Partial<Record<ItemId, number>>>();
  const bundles = new Map<string, CanvasBeltTopology[]>();
  const topologyBelts: CanvasBeltTopology[] = [];
  for (const belt of belts) {
    const topologyBelt: CanvasBeltTopology = {
      id: belt.id,
      planetId,
      source: belt.source,
      target: belt.target,
      itemId: belt.itemId,
      tier: belt.tier,
      lanes: belt.lanes,
      stackSize: belt.stackSize ?? 1,
      priority: belt.priority,
      targetPortIndex: belt.targetPortIndex,
      routeMode: belt.routeMode ?? "auto",
      routeOffsetY: belt.routeOffsetY ?? 0,
    };
    topologyBelts.push(topologyBelt);

    const targetInputs = connectedInputsByTarget.get(belt.target) ?? [];
    targetInputs.push(belt.itemId);
    connectedInputsByTarget.set(belt.target, targetInputs);
    if (belt.targetPortIndex !== undefined) {
      const ports = targetPortItemsByEntity.get(belt.target) ?? {};
      ports[belt.targetPortIndex] = belt.itemId;
      targetPortItemsByEntity.set(belt.target, ports);
    }

    const sourceOccupancy = output.get(belt.source) ?? {};
    sourceOccupancy[belt.itemId] = (sourceOccupancy[belt.itemId] ?? 0) + belt.lanes;
    output.set(belt.source, sourceOccupancy);
    const targetOccupancy = input.get(belt.target) ?? {};
    targetOccupancy[belt.itemId] = (targetOccupancy[belt.itemId] ?? 0) + belt.lanes;
    input.set(belt.target, targetOccupancy);

    const bundleKey = `${belt.source}:${belt.target}`;
    const bundle = bundles.get(bundleKey) ?? [];
    bundle.push(topologyBelt);
    bundles.set(bundleKey, bundle);
  }

  const bundleByBeltId = new Map<string, BeltBundleInfo>();
  for (const bundle of bundles.values()) {
    bundle.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.id.localeCompare(right.id));
    bundle.forEach((belt, index) => bundleByBeltId.set(belt.id, { index, size: bundle.length }));
  }

  return {
    planetId,
    revision: topologyRevision ?? (previous?.revision ?? 0) + 1,
    signature,
    entities: entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      buildingId: entity.buildingId,
      x: entity.position.x,
      y: entity.position.y,
    })),
    belts: topologyBelts,
    connectedInputsByTarget,
    targetPortItemsByEntity,
    occupancy: { input, output },
    bundleByBeltId,
  };
}

function buildRectGrid(rectangles: readonly CanvasNodeRectangle[]): Map<number, CanvasNodeRectangle[]> {
  const cellWidth = 320;
  const grid = new Map<number, CanvasNodeRectangle[]>();
  for (const rectangle of rectangles) {
    const first = Math.floor(rectangle.x / cellWidth);
    const last = Math.floor((rectangle.x + rectangle.width) / cellWidth);
    for (let cell = first; cell <= last; cell += 1) {
      const values = grid.get(cell);
      if (values) values.push(rectangle);
      else grid.set(cell, [rectangle]);
    }
  }
  return grid;
}

export function buildFactoryEdgeRouteCenters(
  topology: FactoryCanvasTopology,
  rectangles: readonly CanvasNodeRectangle[],
  simplified: boolean,
): ReadonlyMap<string, number | undefined> {
  const result = new Map<string, number | undefined>();
  const rectById = new Map(rectangles.map((rectangle) => [rectangle.id, rectangle]));
  const grid = buildRectGrid(rectangles);
  const cellWidth = 320;
  for (const belt of topology.belts) {
    const mode = belt.routeMode ?? "auto";
    if (mode === "bezier" || simplified) {
      result.set(belt.id, undefined);
      continue;
    }
    const source = rectById.get(belt.source);
    const target = rectById.get(belt.target);
    if (!source || !target) {
      result.set(belt.id, undefined);
      continue;
    }
    const bundle = topology.bundleByBeltId.get(belt.id) ?? { index: 0, size: 1 };
    const bundleOffset = (bundle.index - (bundle.size - 1) / 2) * 18;
    const sourceY = source.y + source.height / 2;
    const targetY = target.y + target.height / 2;
    if (mode === "manual") {
      result.set(belt.id, (sourceY + targetY) / 2 + (belt.routeOffsetY ?? 0) + bundleOffset);
      continue;
    }
    if (mode === "upper") {
      result.set(belt.id, Math.min(source.y, target.y) - 64 + bundleOffset);
      continue;
    }
    if (mode === "lower") {
      result.set(belt.id, Math.max(source.y + source.height, target.y + target.height) + 64 + bundleOffset);
      continue;
    }

    const sourceX = source.x + source.width;
    const targetX = target.x;
    const left = Math.min(sourceX, targetX);
    const right = Math.max(sourceX, targetX);
    const candidates = new Map<string, CanvasNodeRectangle>();
    for (let cell = Math.floor(left / cellWidth); cell <= Math.floor(right / cellWidth); cell += 1) {
      for (const rectangle of grid.get(cell) ?? []) candidates.set(rectangle.id, rectangle);
    }
    const blockers = [...candidates.values()].filter((rectangle) => {
      if (rectangle.id === source.id || rectangle.id === target.id || rectangle.x > right || rectangle.x + rectangle.width < left) return false;
      const ratio = right - left > 0.001 ? (rectangle.x + rectangle.width / 2 - left) / (right - left) : 0.5;
      const routeY = sourceY + (targetY - sourceY) * Math.max(0, Math.min(1, ratio));
      return routeY >= rectangle.y - 18 && routeY <= rectangle.y + rectangle.height + 18;
    });
    if (blockers.length === 0) {
      result.set(belt.id, (sourceY + targetY) / 2 + bundleOffset);
      continue;
    }
    const upper = Math.min(sourceY, targetY, ...blockers.map((rectangle) => rectangle.y)) - 52;
    const lower = Math.max(sourceY, targetY, ...blockers.map((rectangle) => rectangle.y + rectangle.height)) + 52;
    const midpoint = (sourceY + targetY) / 2;
    result.set(belt.id, (Math.abs(midpoint - upper) <= Math.abs(lower - midpoint) ? upper : lower) + bundleOffset);
  }
  return result;
}
