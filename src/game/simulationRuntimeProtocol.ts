import type { BeltConnection, FactoryEntity, GameState } from "./types";
import { collectGameStateEditLineage } from "./gameStateEditLineage";

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

/**
 * Immutable relay form for a large checkpoint. The page can pass the Blob
 * handle between Workers without adopting the full backing ArrayBuffer; only
 * the destination simulation Worker materializes and validates the bytes.
 */
export interface SimulationStateBlobTransfer {
  protocolVersion: typeof SIMULATION_RUNTIME_PROTOCOL_VERSION;
  byteLength: number;
  blob: Blob;
}

/** Small proof returned beside a transferred checkpoint. The simulation
 * Worker derives this from the same in-memory state it serializes, allowing
 * the UI to validate the handoff without cloning the full decoded state. */
export interface SimulationStateIdentity {
  version: number;
  mode: GameState["mode"];
  activePlanetId: GameState["activePlanetId"];
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
  paused: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeSimulationState(state: GameState): { raw: string; transfer: SimulationStateTransfer } {
  const raw = JSON.stringify(state);
  const bytes = textEncoder.encode(raw);
  return { raw, transfer: {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    byteLength: bytes.byteLength,
    buffer: bytes.buffer,
  } };
}

function validateSimulationStateShape(value: unknown): GameState {
  const parsed = value as Partial<GameState> | null;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities) || !Array.isArray(parsed.belts)) {
    throw new Error("模拟运行时状态结构无效");
  }
  return parsed as GameState;
}

function validateSimulationStateTransferEnvelope(transfer: SimulationStateTransfer): void {
  if (transfer.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟运行时传输协议 ${transfer.protocolVersion}`);
  }
  if (!(transfer.buffer instanceof ArrayBuffer) || transfer.byteLength !== transfer.buffer.byteLength) {
    throw new Error("模拟运行时传输长度校验失败");
  }
}

export function createSimulationStateIdentity(state: GameState): SimulationStateIdentity {
  return {
    version: state.version,
    mode: state.mode,
    activePlanetId: state.activePlanetId,
    entityCount: state.entities.length,
    beltCount: state.belts.length,
    elapsedSeconds: state.elapsedSeconds,
    paused: state.paused,
  };
}

/** Validate the bounded identity proof independently from checkpoint bytes.
 * Authority-adoption responses deliberately keep the full checkpoint inside
 * the simulation Worker, so the UI must be able to verify the streamed mirror
 * without receiving another multi-megabyte ArrayBuffer. */
export function validateSimulationStateIdentity(
  identity: SimulationStateIdentity | undefined,
): SimulationStateIdentity {
  if (!identity || !Number.isSafeInteger(identity.version) || identity.version <= 0 ||
    (identity.mode !== "normal" && identity.mode !== "speedrun") ||
    typeof identity.activePlanetId !== "string" || identity.activePlanetId.length === 0 ||
    !Number.isSafeInteger(identity.entityCount) || identity.entityCount < 0 ||
    !Number.isSafeInteger(identity.beltCount) || identity.beltCount < 0 ||
    !Number.isFinite(identity.elapsedSeconds) || identity.elapsedSeconds < 0 ||
    typeof identity.paused !== "boolean") {
    throw new Error("模拟运行时 checkpoint 身份无效");
  }
  return identity;
}

/** Validate the transferable envelope and its bounded Worker proof without
 * decoding or structured-cloning the checkpoint body on the UI thread. */
export function validateSimulationStateTransferIdentity(
  transfer: SimulationStateTransfer,
  identity: SimulationStateIdentity | undefined,
): SimulationStateIdentity {
  validateSimulationStateTransferEnvelope(transfer);
  return validateSimulationStateIdentity(identity);
}

export function serializeSimulationStateForTransfer(state: GameState): SimulationStateTransfer {
  // The simulation Worker can already be near its heap limit after a long run.
  // Encode record arrays a row at a time: retain binary chunks, never a second
  // full-state JSON string beside the authority. Keep the exact v1 JSON bytes;
  // this is not a persistent-save projection or a change to runtime fields.
  if ("toJSON" in state) return encodeSimulationState(state).transfer;
  const chunks: Uint8Array[] = [];
  let chunk = new Uint8Array(64 * 1024);
  let used = 0;
  let byteLength = 0;
  const flush = () => {
    if (used === 0) return;
    chunks.push(chunk.subarray(0, used));
    byteLength += used;
    chunk = new Uint8Array(64 * 1024);
    used = 0;
  };
  const append = (text: string) => {
    let offset = 0;
    while (offset < text.length) {
      const encoded = textEncoder.encodeInto(text.slice(offset), chunk.subarray(used));
      offset += encoded.read;
      used += encoded.written;
      // encodeInto never splits a surrogate pair. A short tail may therefore
      // be full for the next character even when one to three bytes remain.
      if (offset < text.length) flush();
    }
  };
  const memberJson = (key: string, value: unknown): string | undefined => {
    // A wrapper preserves native toJSON(key), undefined/function omission and
    // all number/string escaping semantics without implementing JSON ourselves.
    const json = JSON.stringify({ [key]: value });
    return json === "{}" ? undefined : json.slice(JSON.stringify(key).length + 2, -1);
  };
  append("{");
  let members = 0;
  for (const key of Object.keys(state)) {
    const value = (state as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value) && !("toJSON" in value)) {
      append(`${members++ > 0 ? "," : ""}${JSON.stringify(key)}:[`);
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (index > 0) append(",");
        append(memberJson(String(index), value[index]) ?? "null");
      }
      append("]");
    } else {
      const json = memberJson(key, value);
      if (json === undefined) continue;
      append(`${members++ > 0 ? "," : ""}${JSON.stringify(key)}:`);
      append(json);
    }
  }
  append("}");
  flush();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION, byteLength, buffer: bytes.buffer };
}

/**
 * Checkpoint responses need both transferable persistence bytes and a main
 * thread mirror. Both values are created from the same JSON text so optional
 * `undefined` leaves follow the persisted-state contract exactly.
 */
export function serializeSimulationStateCheckpoint(state: GameState): {
  checkpoint: SimulationStateTransfer;
  checkpointState: GameState;
} {
  const encoded = encodeSimulationState(state);
  return {
    checkpoint: encoded.transfer,
    checkpointState: validateSimulationStateShape(JSON.parse(encoded.raw)),
  };
}

/** Validate a Worker-created checkpoint without decoding its large buffer on UI. */
export function validateSimulationStateCheckpoint(
  transfer: SimulationStateTransfer,
  checkpointState: unknown,
): GameState {
  validateSimulationStateTransferEnvelope(transfer);
  return validateSimulationStateShape(checkpointState);
}

export function deserializeSimulationStateTransfer(transfer: SimulationStateTransfer): GameState {
  validateSimulationStateTransferEnvelope(transfer);
  return validateSimulationStateShape(JSON.parse(textDecoder.decode(new Uint8Array(transfer.buffer))));
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
  // UI commands commonly change only a top-level leaf such as paused state or
  // the persisted viewport. GameState updates preserve the immutable entity
  // and belt array references in that case, so scanning tens of thousands of
  // records cannot discover a change and only blocks the next Worker post.
  if (previous === current) {
    return {
      changed: [] as SimulationRecordPatch[],
      added: [] as Array<{ index: number; value: T }>,
      removed: [] as string[],
    };
  }
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

function createRecordPatchesForTouchedIds<T extends { id: string }>(
  previous: readonly T[],
  current: readonly T[],
  touchedIds: ReadonlySet<string>,
) {
  if (touchedIds.size === 0) {
    return {
      changed: [] as SimulationRecordPatch[],
      added: [] as Array<{ index: number; value: T }>,
      removed: [] as string[],
    };
  }
  // Scan the ordinary v47 arrays once but retain only touched records. A
  // one-building edit no longer allocates two 80k/155k Map/Set indexes merely
  // to encode its revisioned command.
  const previousById = new Map<string, T>();
  const currentById = new Map<string, { index: number; value: T }>();
  const currentTouched: Array<{ index: number; value: T }> = [];
  for (const record of previous) if (touchedIds.has(record.id)) previousById.set(record.id, record);
  current.forEach((record, index) => {
    if (!touchedIds.has(record.id)) return;
    const indexed = { index, value: record };
    currentById.set(record.id, indexed);
    currentTouched.push(indexed);
  });
  const changed: SimulationRecordPatch[] = [];
  const added: Array<{ index: number; value: T }> = [];
  for (const indexed of currentTouched) {
    const before = previousById.get(indexed.value.id);
    if (!before) {
      added.push(indexed);
      continue;
    }
    if (before === indexed.value) continue;
    const changes = createValuePatches(before, indexed.value);
    if (changes.length > 0) changed.push({ id: indexed.value.id, changes });
  }
  const removed: string[] = [];
  for (const record of previous) {
    if (touchedIds.has(record.id) && !currentById.has(record.id)) removed.push(record.id);
  }
  return { changed, added, removed };
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
  const lineage = collectGameStateEditLineage(previous, current);
  const entities = lineage
    ? createRecordPatchesForTouchedIds(previous.entities, current.entities, lineage.entityIds)
    : createRecordPatches(previous.entities, current.entities);
  const belts = lineage
    ? createRecordPatchesForTouchedIds(previous.belts, current.belts, lineage.beltIds)
    : createRecordPatches(previous.belts, current.belts);
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

interface PatchPathValue {
  exists: boolean;
  value?: unknown;
}

function readPatchPath(root: unknown, path: readonly SimulationPatchPathSegment[]): PatchPathValue {
  if (path.length === 0) return { exists: true, value: root };
  let cursor = root;
  for (const segment of path) {
    if (!isContainer(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { exists: false };
    }
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return { exists: true, value: cursor };
}

function invertValuePatch(root: unknown, patch: SimulationValuePatch): SimulationValuePatch {
  const previous = readPatchPath(root, patch.path);
  return previous.exists
    ? { path: [...patch.path], operation: "set", value: previous.value }
    : { path: [...patch.path], operation: "delete" };
}

function collectInverseRecordSources<T extends { id: string }>(
  previous: readonly T[],
  changed: readonly SimulationRecordPatch[],
  removedIds: readonly string[],
): Map<string, { index: number; value: T }> {
  const wanted = new Set<string>([
    ...changed.map((record) => record.id),
    ...removedIds,
  ]);
  const result = new Map<string, { index: number; value: T }>();
  if (wanted.size === 0) return result;
  previous.forEach((value, index) => {
    if (wanted.has(value.id)) result.set(value.id, { index, value });
  });
  return result;
}

function invertRecordPatches<T extends { id: string }>(
  previous: readonly T[],
  changed: readonly SimulationRecordPatch[],
  added: readonly { index: number; value: T }[],
  removedIds: readonly string[],
): {
  changed: SimulationRecordPatch[];
  added: Array<{ index: number; value: T }>;
  removedIds: string[];
} {
  const sources = collectInverseRecordSources(previous, changed, removedIds);
  const inverseChanged = changed.map((record) => {
    const source = sources.get(record.id)?.value;
    if (!source) throw new Error(`无法为记录 ${record.id} 创建逆向模拟命令`);
    return {
      id: record.id,
      changes: record.changes.map((change) => invertValuePatch(source, change)),
    };
  });
  const inverseAdded = removedIds.map((id) => {
    const source = sources.get(id);
    if (!source) throw new Error(`无法为已删除记录 ${id} 创建逆向模拟命令`);
    return source;
  });
  return {
    changed: inverseChanged,
    added: inverseAdded,
    removedIds: added.map((entry) => entry.value.id),
  };
}

/**
 * Build the undo command from the already-computed forward patch. This scans
 * ordinary v47 arrays once for only the touched/removed ids and avoids a
 * second global 80k/155k diff (and its temporary Maps) for every history item.
 */
export function invertSimulationCommandPatch(
  previous: GameState,
  patch: SimulationCommandPatch,
  baseRevision = patch.baseRevision,
): SimulationCommandPatch {
  if (patch.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟命令协议 ${patch.protocolVersion}`);
  }
  const entities = invertRecordPatches(
    previous.entities,
    patch.changedEntities,
    patch.addedEntities,
    patch.removedEntityIds,
  );
  const belts = invertRecordPatches(
    previous.belts,
    patch.changedBelts,
    patch.addedBelts,
    patch.removedBeltIds,
  );
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: patch.topLevelChanges.map((change) => invertValuePatch(previous, change)),
    changedEntities: entities.changed,
    addedEntities: entities.added,
    removedEntityIds: entities.removedIds,
    changedBelts: belts.changed,
    addedBelts: belts.added,
    removedBeltIds: belts.removedIds,
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

export interface MutableSimulationCommandResult {
  state: GameState;
  topologyDirty: boolean;
  dynamicRouteDirty: boolean;
  changedEntityIds: string[];
  changedBeltIds: string[];
  dirtyPlanetIds: GameState["activePlanetId"][];
}

export interface MutableSimulationCommandIndex {
  entityById?: ReadonlyMap<string, FactoryEntity>;
  beltById?: ReadonlyMap<string, BeltConnection>;
}

const SAFE_MUTABLE_ENTITY_FIELDS = new Set([
  "position", "inputs", "outputs", "progress", "routingCursor", "utilization", "productionRate", "powerFactor",
  "stationProgress", "stationTrips", "stationLastTransfer", "stationDrones", "stationVessels", "stationWarpers",
  "stationCongestion", "stationDispatchCursor", "stationLastSupplyPeerBySlot", "fuelRemainingMj", "powerOutputKw",
  "powerInputKw", "storedEnergyMj", "orbitalCargoProgress", "orbitalCargoTotalUploaded", "blackHolePorts",
  "proliferatorBonusProgress",
]);
const SAFE_MUTABLE_BELT_FIELDS = new Set(["progress", "totalTransferred", "congestion", "lastFlow", "monitorEnabled"]);
const SAFE_MUTABLE_TOP_LEVEL_FIELDS = new Set([
  "paused", "elapsedSeconds", "lastSavedAt", "totalProduced", "productionHistory", "metrics", "planetMetrics", "powerGridMetrics",
  "canvasBookmarks", "canvasRegions", "planetViewports", "timeWarp", "idleSettlement",
]);

function applyValuePatchMutable(root: unknown, patch: SimulationValuePatch): unknown {
  if (patch.path.length === 0) return patch.operation === "delete" ? undefined : patch.value;
  let cursor = root as Record<string | number, unknown> | unknown[];
  for (let index = 0; index < patch.path.length - 1; index += 1) {
    const segment = patch.path[index];
    let child = (cursor as Record<string | number, unknown>)[segment];
    if (!isContainer(child)) {
      child = typeof patch.path[index + 1] === "number" ? [] : {};
      (cursor as Record<string | number, unknown>)[segment] = child;
    }
    cursor = child as Record<string | number, unknown> | unknown[];
  }
  const leaf = patch.path.at(-1)!;
  if (patch.operation === "delete") {
    if (Array.isArray(cursor) && typeof leaf === "number") cursor.splice(leaf, 1);
    else delete (cursor as Record<string | number, unknown>)[leaf];
  } else {
    (cursor as Record<string | number, unknown>)[leaf] = patch.value;
  }
  return root;
}

/**
 * Worker-only command application. Runtime records are mutated in place so
 * stable simulation indexes keep their entity/belt references. Index-sensitive
 * edits are explicitly marked dirty and still fall back to the full rebuild.
 */
export function applySimulationCommandPatchMutable(
  state: GameState,
  patch: SimulationCommandPatch,
  index: MutableSimulationCommandIndex = {},
): MutableSimulationCommandResult {
  if (patch.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟命令协议 ${patch.protocolVersion}`);
  }
  let topologyDirty = patch.addedEntities.length > 0 || patch.removedEntityIds.length > 0 ||
    patch.addedBelts.length > 0 || patch.removedBeltIds.length > 0;
  let dynamicRouteDirty = false;
  const dirtyPlanets = new Set<GameState["activePlanetId"]>();
  for (const change of patch.topLevelChanges) {
    const root = String(change.path[0] ?? "");
    if (!SAFE_MUTABLE_TOP_LEVEL_FIELDS.has(root)) topologyDirty = true;
    applyValuePatchMutable(state, change);
  }

  const entityIndex = patch.changedEntities.length > 0 && !index.entityById
    ? new Map(state.entities.map((entity) => [entity.id, entity]))
    : index.entityById;
  for (const record of patch.changedEntities) {
    let entity = entityIndex?.get(record.id);
    if (!entity) {
      topologyDirty = true;
      continue;
    }
    dirtyPlanets.add(entity.planetId);
    for (const change of record.changes) {
      const root = String(change.path[0] ?? "");
      if (root === "stationRoutes") dynamicRouteDirty = true;
      else if (!SAFE_MUTABLE_ENTITY_FIELDS.has(root)) topologyDirty = true;
      entity = applyValuePatchMutable(entity, change) as FactoryEntity;
    }
    dirtyPlanets.add(entity.planetId);
  }

  const beltIndex = patch.changedBelts.length > 0 && !index.beltById
    ? new Map(state.belts.map((belt) => [belt.id, belt]))
    : index.beltById;
  for (const record of patch.changedBelts) {
    let belt = beltIndex?.get(record.id);
    if (!belt) {
      topologyDirty = true;
      continue;
    }
    dirtyPlanets.add(belt.planetId);
    for (const change of record.changes) {
      const root = String(change.path[0] ?? "");
      if (!SAFE_MUTABLE_BELT_FIELDS.has(root)) topologyDirty = true;
      belt = applyValuePatchMutable(belt, change) as BeltConnection;
    }
    dirtyPlanets.add(belt.planetId);
  }

  if (patch.removedEntityIds.length > 0) {
    const removed = new Set(patch.removedEntityIds);
    for (const entity of state.entities) if (removed.has(entity.id)) dirtyPlanets.add(entity.planetId);
    state.entities = state.entities.filter((entity) => !removed.has(entity.id));
  }
  for (const addition of [...patch.addedEntities].sort((left, right) => left.index - right.index)) {
    if (state.entities.some((entity) => entity.id === addition.value.id)) continue;
    state.entities.splice(Math.max(0, Math.min(state.entities.length, addition.index)), 0, addition.value);
    dirtyPlanets.add(addition.value.planetId);
  }
  if (patch.removedBeltIds.length > 0) {
    const removed = new Set(patch.removedBeltIds);
    for (const belt of state.belts) if (removed.has(belt.id)) dirtyPlanets.add(belt.planetId);
    state.belts = state.belts.filter((belt) => !removed.has(belt.id));
  }
  for (const addition of [...patch.addedBelts].sort((left, right) => left.index - right.index)) {
    if (state.belts.some((belt) => belt.id === addition.value.id)) continue;
    state.belts.splice(Math.max(0, Math.min(state.belts.length, addition.index)), 0, addition.value);
    dirtyPlanets.add(addition.value.planetId);
  }
  return {
    state,
    topologyDirty,
    dynamicRouteDirty,
    changedEntityIds: patch.changedEntities.map((record) => record.id),
    changedBeltIds: patch.changedBelts.map((record) => record.id),
    dirtyPlanetIds: [...dirtyPlanets],
  };
}

export function simulationCommandPatchIsEmpty(patch: SimulationCommandPatch | null | undefined): boolean {
  return !patch || (patch.topLevelChanges.length === 0 && patch.changedEntities.length === 0 && patch.addedEntities.length === 0 &&
    patch.removedEntityIds.length === 0 && patch.changedBelts.length === 0 && patch.addedBelts.length === 0 && patch.removedBeltIds.length === 0);
}
