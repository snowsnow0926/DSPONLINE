import type { BeltConnection, FactoryEntity, GameState } from "./types";

/**
 * Experimental P4 protocol. It carries only changed entities/belts and
 * top-level fields while the Worker remains authoritative. The full-state
 * protocol remains the default and is the fallback when a revision cannot be
 * applied safely.
 */
export interface SimulationStateDelta {
  protocolVersion: 1;
  baseRevision: number;
  nextRevision: number;
  changedEntities: FactoryEntity[];
  removedEntityIds: string[];
  changedBelts: BeltConnection[];
  removedBeltIds: string[];
  topLevel: Partial<Omit<GameState, "entities" | "belts">>;
}

/**
 * Compare wire sizes before opting into the experimental delta transport.
 * JSON byte length is a conservative UTF-16 approximation here; both values
 * use the same encoding, so it is sufficient for the relative decision and
 * avoids introducing a second serialization format.
 */
export function shouldUseSimulationDelta(state: GameState, delta: SimulationStateDelta): boolean {
  return JSON.stringify(delta).length < JSON.stringify(state).length;
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function changedRecords<T extends { id: string }>(previous: T[], current: T[]): { changed: T[]; removed: string[] } {
  const before = new Map(previous.map((entry) => [entry.id, serialized(entry)]));
  const changed = current.filter((entry) => before.get(entry.id) !== serialized(entry));
  const currentIds = new Set(current.map((entry) => entry.id));
  const removed = previous.filter((entry) => !currentIds.has(entry.id)).map((entry) => entry.id);
  return { changed, removed };
}

export function createSimulationStateDelta(previous: GameState, current: GameState, baseRevision: number, nextRevision: number): SimulationStateDelta {
  const entities = changedRecords(previous.entities, current.entities);
  const belts = changedRecords(previous.belts, current.belts);
  const topLevel = {} as SimulationStateDelta["topLevel"];
  // The type assertion used by the original experimental implementation did
  // not filter runtime keys. At runtime `Object.keys` still contains the two
  // large record arrays, duplicating them inside `topLevel` and defeating the
  // delta protocol entirely.
  for (const key of Object.keys(current) as Array<keyof GameState>) {
    if (key === "entities" || key === "belts") continue;
    if (serialized(previous[key]) !== serialized(current[key])) {
      (topLevel as Record<string, unknown>)[key] = current[key];
    }
  }
  return {
    protocolVersion: 1,
    baseRevision,
    nextRevision,
    changedEntities: entities.changed,
    removedEntityIds: entities.removed,
    changedBelts: belts.changed,
    removedBeltIds: belts.removed,
    topLevel,
  };
}

function applyRecords<T extends { id: string }>(previous: T[], changed: T[], removed: string[]): T[] {
  const changedById = new Map(changed.map((entry) => [entry.id, entry]));
  const removedIds = new Set(removed);
  const result = previous.flatMap((entry) => {
    if (removedIds.has(entry.id)) return [];
    return changedById.get(entry.id) ?? entry;
  });
  const existing = new Set(previous.map((entry) => entry.id));
  return result.concat(changed.filter((entry) => !existing.has(entry.id)));
}

export function applySimulationStateDelta(base: GameState, delta: SimulationStateDelta): GameState {
  if (delta.protocolVersion !== 1) throw new Error(`不支持的模拟增量协议 ${delta.protocolVersion}`);
  return {
    ...base,
    ...delta.topLevel,
    entities: applyRecords(base.entities, delta.changedEntities, delta.removedEntityIds),
    belts: applyRecords(base.belts, delta.changedBelts, delta.removedBeltIds),
  };
}

/** Device-local developer switch; it never enters GameState or save data. */
export function readExperimentalSimulationDeltaMode(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem("dsp-idle-network.experimental-simulation-delta.v1") === "true";
  } catch {
    return false;
  }
}
