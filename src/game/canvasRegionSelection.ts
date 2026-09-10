import { moveEntities } from "./engine";
import type { CanvasRegion, GameState } from "./types";

export function enclosedCanvasRegionIds(regions: readonly CanvasRegion[], planetId: string,
  start: { x: number; y: number }, end: { x: number; y: number }): string[] {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  if (![left, top, right, bottom].every(Number.isFinite) || right - left < 1 || bottom - top < 1) return [];
  return regions.filter((region) => region.planetId === planetId && region.x >= left && region.y >= top &&
    region.x + region.width <= right && region.y + region.height <= bottom).map((region) => region.id);
}

/** Commit positions and selected labels together so history and persistence see one edit. */
export function moveCanvasSelection(state: GameState,
  positions: Array<{ id: string; position: { x: number; y: number } }>,
  regions: readonly CanvasRegion[], delta: { x: number; y: number }): GameState {
  if (![delta.x, delta.y, ...positions.flatMap(({ position }) => [position.x, position.y])].every(Number.isFinite)) return state;
  const selected = new Map(regions.map((region) => [region.id, region]));
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  if (selected.size && positions.some(({ id, position }) => {
    const entity = entityById.get(id);
    return !entity || entity.planetId !== state.activePlanetId || entity.interactionLocked ||
      Math.abs(entity.position.x + delta.x - position.x) > 0.000001 ||
      Math.abs(entity.position.y + delta.y - position.y) > 0.000001;
  })) return state;
  // A different planet or an intervening region edit invalidates the entire gesture.
  for (const original of selected.values()) {
    const current = state.canvasRegions.find((region) => region.id === original.id);
    if (!current || current.planetId !== state.activePlanetId || original.planetId !== current.planetId ||
        current.x !== original.x || current.y !== original.y ||
        current.width !== original.width || current.height !== original.height ||
        !Number.isFinite(current.x + delta.x) || !Number.isFinite(current.y + delta.y)) return state;
  }
  if (delta.x === 0 && delta.y === 0) return state;
  const moved = moveEntities(state, positions);
  if (moved === state) return state;
  if (selected.size === 0) return moved;
  return { ...moved, canvasRegions: state.canvasRegions.map((region) => selected.has(region.id)
    ? { ...region, x: region.x + delta.x, y: region.y + delta.y } : region) };
}
