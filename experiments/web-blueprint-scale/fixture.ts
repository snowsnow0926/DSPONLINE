import { createInitialState, placeBuilding } from "../../src/game/engine";
import type { BeltConnection, GameState } from "../../src/game/types";

/** Synthetic, uniquely identified storage grid; the supplied factory stays shared. */
export function blueprintScaleFixture(base: GameState, nodes = 4_096, lines = 8_192) {
  const seed = createInitialState();
  seed.construction.storage_mk1 = 1;
  const prototype = placeBuilding(seed, "storage_mk1", { x: 0, y: 0 }).entities
    .find((entity) => entity.buildingId === "storage_mk1")!;
  const entities = Array.from({ length: nodes }, (_, index) => ({
    ...prototype,
    id: `blueprint_scale_entity_${index}`,
    planetId: base.activePlanetId,
    position: { x: (index % 64) * 200, y: Math.floor(index / 64) * 180 },
    storedItemId: "iron_ingot" as const,
    inputs: {}, outputs: {}, proliferatorBonusProgress: {},
  }));
  const belts: BeltConnection[] = Array.from({ length: lines }, (_, index) => ({
    id: `blueprint_scale_belt_${index}`,
    planetId: base.activePlanetId,
    source: entities[index % nodes].id,
    target: entities[(index + 1 + Math.floor(index / nodes)) % nodes].id,
    itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1,
    progress: 0, priority: 0, totalTransferred: 0, congestion: 0, lastFlow: 0,
  }));
  const ids = new Set([...base.entities.map((entity) => entity.id), ...base.belts.map((belt) => belt.id)]);
  if ([...entities, ...belts].some((row) => ids.has(row.id))) throw new Error("Scale fixture ID collision");
  return {
    state: { ...base, entities: [...base.entities, ...entities], belts: [...base.belts, ...belts] },
    entityIds: entities.map((entity) => entity.id),
  };
}
