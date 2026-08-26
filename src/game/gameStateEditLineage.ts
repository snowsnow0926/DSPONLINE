import type { GameState } from "./types";

export interface GameStateEditDelta {
  entityIds?: readonly string[];
  beltIds?: readonly string[];
}

export interface CollectedGameStateEditDelta {
  entityIds: Set<string>;
  beltIds: Set<string>;
  depth: number;
}

interface GameStateEditLineageEntry {
  parent: GameState;
  entityIds: readonly string[];
  beltIds: readonly string[];
}

const editLineage = new WeakMap<GameState, GameStateEditLineageEntry>();
const MAX_EDIT_LINEAGE_DEPTH = 4_096;

/**
 * Attach a bounded, runtime-only changed-record lineage to an immutable edit
 * result. Nothing is serialized and the WeakMap cannot keep an abandoned
 * GameState alive. The command encoder can then diff only touched ids instead
 * of allocating global 80k/155k lookup Maps after every small player edit.
 */
export function recordGameStateEditLineage(
  result: GameState,
  parent: GameState,
  delta: GameStateEditDelta,
): GameState {
  if (result === parent) return result;
  editLineage.set(result, {
    parent,
    entityIds: [...new Set(delta.entityIds ?? [])],
    beltIds: [...new Set(delta.beltIds ?? [])],
  });
  return result;
}

/** Return null unless every state boundary back to `ancestor` is known. A
 * partial lineage must fall back to the complete compatibility comparator. */
export function collectGameStateEditLineage(
  ancestor: GameState,
  descendant: GameState,
): CollectedGameStateEditDelta | null {
  const entityIds = new Set<string>();
  const beltIds = new Set<string>();
  let cursor = descendant;
  let depth = 0;
  while (cursor !== ancestor) {
    if (depth >= MAX_EDIT_LINEAGE_DEPTH) return null;
    const entry = editLineage.get(cursor);
    if (!entry) return null;
    for (const id of entry.entityIds) entityIds.add(id);
    for (const id of entry.beltIds) beltIds.add(id);
    cursor = entry.parent;
    depth += 1;
  }
  return { entityIds, beltIds, depth };
}
