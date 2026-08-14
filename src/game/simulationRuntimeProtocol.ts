import type { BeltConnection, FactoryEntity, GameState } from "./types";

export const SIMULATION_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type SimulationPatchPathSegment = string | number;

export interface SimulationValuePatch {
  path: SimulationPatchPathSegment[];
  operation: "set" | "delete";
  value?: unknown;
}

export interface SimulationRecordPatch {
  id: string;
  changes: SimulationValuePatch[];
}

/**
 * A player/UI command represented as changed JSON leaves rather than a whole
 * GameState. Applying leaves to the Worker's current revision prevents stale
 * off-planet runtime fields from being overwritten by the UI projection.
 */
export interface SimulationCommandPatch {
  protocolVersion: typeof SIMULATION_RUNTIME_PROTOCOL_VERSION;
  baseRevision: number;
  topLevelChanges: SimulationValuePatch[];
  changedEntities: SimulationRecordPatch[];
  addedEntities: Array<{ index: number; value: FactoryEntity }>;
  removedEntityIds: string[];
  changedBelts: SimulationRecordPatch[];
  addedBelts: Array<{ index: number; value: BeltConnection }>;
  removedBeltIds: string[];
}

export interface SimulationStateTransfer {
  protocolVersion: typeof SIMULATION_RUNTIME_PROTOCOL_VERSION;
  byteLength: number;
  buffer: ArrayBuffer;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function serializeSimulationStateForTransfer(state: GameState): SimulationStateTransfer {
  const bytes = textEncoder.encode(JSON.stringify(state));
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    byteLength: bytes.byteLength,
    buffer: bytes.buffer,
  };
}

export function deserializeSimulationStateTransfer(transfer: SimulationStateTransfer): GameState {
  if (transfer.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟运行时传输协议 ${transfer.protocolVersion}`);
  }
  if (transfer.byteLength !== transfer.buffer.byteLength) {
    throw new Error("模拟运行时传输长度校验失败");
  }
  const parsed = JSON.parse(textDecoder.decode(new Uint8Array(transfer.buffer))) as Partial<GameState>;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities) || !Array.isArray(parsed.belts)) {
    throw new Error("模拟运行时状态结构无效");
  }
  return parsed as GameState;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Boolean(value) && typeof value === "object";
}

function createValuePatches(previous: unknown, current: unknown, path: SimulationPatchPathSegment[] = []): SimulationValuePatch[] {
  if (Object.is(previous, current)) return [];
  if (!isContainer(previous) || !isContainer(current) || Array.isArray(previous) !== Array.isArray(current)) {
    return [{ path, operation: "set", value: current }];
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    // Arrays whose topology changes are intentionally replaced. Equal-length
    // arrays are diffed by index so a station-slot setting cannot overwrite a
    // newer inventory amount in another slot.
    if (previous.length !== current.length) return [{ path, operation: "set", value: current }];
    return current.flatMap((value, index) => createValuePatches(previous[index], value, [...path, index]));
  }
  const before = previous as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  const changes: SimulationValuePatch[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) {
      changes.push({ path: [...path, key], operation: "delete" });
      continue;
    }
    changes.push(...createValuePatches(before[key], after[key], [...path, key]));
  }
  return changes;
}

function createRecordPatches<T extends { id: string }>(previous: readonly T[], current: readonly T[]) {
  const previousById = new Map(previous.map((record) => [record.id, record]));
  const currentIds = new Set(current.map((record) => record.id));
  const changed: SimulationRecordPatch[] = [];
  const added: Array<{ index: number; value: T }> = [];
  current.forEach((record, index) => {
    const before = previousById.get(record.id);
    if (!before) {
      added.push({ index, value: record });
      return;
    }
    if (before === record) return;
    const changes = createValuePatches(before, record);
    if (changes.length > 0) changed.push({ id: record.id, changes });
  });
  return {
    changed,
    added,
    removed: previous.filter((record) => !currentIds.has(record.id)).map((record) => record.id),
  };
}

export function createSimulationCommandPatch(
  previous: GameState,
  current: GameState,
  baseRevision: number,
): SimulationCommandPatch | null {
  if (previous === current) return null;
  const topLevelChanges: SimulationValuePatch[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  keys.delete("entities");
  keys.delete("belts");
  for (const key of keys) {
    const before = (previous as unknown as Record<string, unknown>)[key];
    const afterRecord = current as unknown as Record<string, unknown>;
    if (!(key in afterRecord)) {
      topLevelChanges.push({ path: [key], operation: "delete" });
      continue;
    }
    topLevelChanges.push(...createValuePatches(before, afterRecord[key], [key]));
  }
  const entities = createRecordPatches(previous.entities, current.entities);
  const belts = createRecordPatches(previous.belts, current.belts);
  if (topLevelChanges.length === 0 && entities.changed.length === 0 && entities.added.length === 0 && entities.removed.length === 0 &&
    belts.changed.length === 0 && belts.added.length === 0 && belts.removed.length === 0) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges,
    changedEntities: entities.changed,
    addedEntities: entities.added,
    removedEntityIds: entities.removed,
    changedBelts: belts.changed,
    addedBelts: belts.added,
    removedBeltIds: belts.removed,
  };
}

function applyValuePatch(root: unknown, patch: SimulationValuePatch, offset = 0): unknown {
  if (offset >= patch.path.length) return patch.operation === "delete" ? undefined : patch.value;
  const segment = patch.path[offset];
  const source = isContainer(root) ? root : typeof segment === "number" ? [] : {};
  const clone: Record<string | number, unknown> | unknown[] = Array.isArray(source) ? [...source] : { ...source };
  const next = applyValuePatch((source as Record<string | number, unknown>)[segment], patch, offset + 1);
  if (patch.operation === "delete" && offset === patch.path.length - 1) {
    if (Array.isArray(clone) && typeof segment === "number") clone.splice(segment, 1);
    else delete (clone as Record<string | number, unknown>)[segment];
  } else {
    (clone as Record<string | number, unknown>)[segment] = next;
  }
  return clone;
}

function applyRecordPatches<T extends { id: string }>(
  previous: readonly T[],
  changed: readonly SimulationRecordPatch[],
  added: readonly { index: number; value: T }[],
  removedIds: readonly string[],
): T[] {
  if (changed.length === 0 && added.length === 0 && removedIds.length === 0) return previous as T[];
  const changedById = new Map(changed.map((record) => [record.id, record.changes]));
  const removed = new Set(removedIds);
  const result = previous.flatMap((record) => {
    if (removed.has(record.id)) return [];
    const patches = changedById.get(record.id);
    if (!patches) return [record];
    return [patches.reduce((value, patch) => applyValuePatch(value, patch) as T, record)];
  });
  for (const addition of [...added].sort((left, right) => left.index - right.index)) {
    if (result.some((record) => record.id === addition.value.id)) continue;
    result.splice(Math.max(0, Math.min(result.length, addition.index)), 0, addition.value);
  }
  return result;
}

export function applySimulationCommandPatch(state: GameState, patch: SimulationCommandPatch): GameState {
  if (patch.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟命令协议 ${patch.protocolVersion}`);
  }
  let next: unknown = state;
  for (const change of patch.topLevelChanges) next = applyValuePatch(next, change);
  const topLevel = next as GameState;
  return {
    ...topLevel,
    entities: applyRecordPatches(topLevel.entities, patch.changedEntities, patch.addedEntities, patch.removedEntityIds),
    belts: applyRecordPatches(topLevel.belts, patch.changedBelts, patch.addedBelts, patch.removedBeltIds),
  };
}

export function simulationCommandPatchIsEmpty(patch: SimulationCommandPatch | null | undefined): boolean {
  return !patch || (patch.topLevelChanges.length === 0 && patch.changedEntities.length === 0 && patch.addedEntities.length === 0 &&
    patch.removedEntityIds.length === 0 && patch.changedBelts.length === 0 && patch.addedBelts.length === 0 && patch.removedBeltIds.length === 0);
}
