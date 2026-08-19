import type { BeltConnection, GameState } from "./types";

/**
 * Resolve controlled inspector inputs from the immutable gameplay projection.
 * Canvas records are mutable, allocation-bounded render wrappers and are not a
 * valid authority for player-editable form controls.
 */
export function selectInspectorBelt(state: GameState, beltId: string | null): BeltConnection | null {
  if (!beltId) return null;
  return state.belts.find((belt) => belt.id === beltId && belt.planetId === state.activePlanetId) ?? null;
}
