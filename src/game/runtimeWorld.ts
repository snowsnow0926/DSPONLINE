import type { SimulationProfiler } from "./engine";
import {
  applySimulationCommandPatch,
  applySimulationValuePatch,
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
  type SimulationPatchPathSegment,
  type SimulationValuePatch,
} from "./simulationRuntimeProtocol";
import {
  captureSimulationProjectionBaseline,
  createSimulationProjection,
  type SimulationProjection,
  type SimulationProjectionBaseline,
} from "./simulationProjection";
import type { BeltConnection, FactoryEntity, GameState } from "./types";

/**
 * Worker-private runtime layout. This version is deliberately independent of
 * GameState/save versions: RuntimeWorld is rebuilt from an authoritative
 * checkpoint and is never serialized.
 */
export const RUNTIME_WORLD_VERSION = 2 as const;

export const RUNTIME_WORLD_DOMAINS = [
  "adapter",
  "entityTopology",
  "beltTopology",
  "production",
  "power",
  "logistics",
  "quantum",
  "statistics",
  "projection",
] as const;

export type RuntimeWorldDomain = typeof RUNTIME_WORLD_DOMAINS[number];
export type RuntimeWorldDomainRevisions = Record<RuntimeWorldDomain, number>;

export interface RuntimeWorldSlot<T extends { id: string }> {
  /** Stable table offset. References use (index, generation), never an id alone. */
  index: number;
  generation: number;
  revision: number;
  id: string | null;
  value: T | null;
}

export interface RuntimeWorldSlotReference {
  index: number;
  generation: number;
}

export interface RuntimeWorldSlotTable<T extends { id: string }> {
  slots: Array<RuntimeWorldSlot<T>>;
  byId: Map<string, number>;
  free: number[];
}

/** Growable bitset used only for candidate propagation, not persistence. */
export class RuntimeWorldDirtyBitset {
  private words = new Uint32Array(0);
  private dirtyCount = 0;

  get size(): number {
    return this.dirtyCount;
  }

  mark(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("RuntimeWorld dirty slot index is invalid");
    const wordIndex = index >>> 5;
    if (wordIndex >= this.words.length) {
      const next = new Uint32Array(Math.max(wordIndex + 1, Math.max(1, this.words.length * 2)));
      next.set(this.words);
      this.words = next;
    }
    const mask = 1 << (index & 31);
    if ((this.words[wordIndex] & mask) !== 0) return;
    this.words[wordIndex] |= mask;
    this.dirtyCount += 1;
  }

  has(index: number): boolean {
    const wordIndex = index >>> 5;
    return wordIndex < this.words.length && (this.words[wordIndex] & (1 << (index & 31))) !== 0;
  }

  clear(): void {
    this.words.fill(0);
    this.dirtyCount = 0;
  }

  values(): number[] {
    const result: number[] = [];
    for (let wordIndex = 0; wordIndex < this.words.length; wordIndex += 1) {
      let word = this.words[wordIndex] >>> 0;
      while (word !== 0) {
        const lowest = word & -word;
        const bit = 31 - Math.clz32(lowest);
        result.push((wordIndex << 5) + bit);
        word = (word ^ lowest) >>> 0;
      }
    }
    return result;
  }
}

export interface RuntimeWorldJournalEntry {
  sequence: number;
  kind: "entity" | "belt" | "top-level" | "domain";
  operation: "add" | "update" | "remove" | "invalidate";
  id?: string;
  slot?: RuntimeWorldSlotReference;
  path?: readonly SimulationPatchPathSegment[];
  domains: readonly RuntimeWorldDomain[];
}

export interface RuntimeWorldJournal {
  sequence: number;
  entries: RuntimeWorldJournalEntry[];
  maximumEntries: number;
  droppedEntries: number;
}

export interface RuntimeWorldProjectionDiagnostics {
  source: "journal" | "projection-v2-fallback";
  comparedWithProjectionV2: boolean;
  matchedProjectionV2: boolean;
  mismatchPath?: string;
  candidateEntityCount: number;
  candidateBeltCount: number;
}

export interface RuntimeWorldProjectionResult {
  projection: SimulationProjection;
  journalProjection: SimulationProjection;
  diagnostics: RuntimeWorldProjectionDiagnostics;
}

export interface RuntimeWorldCommandResult {
  state: GameState;
  lookupInvalidated: boolean;
  invalidatedDomains: RuntimeWorldDomain[];
  changedEntityIds: string[];
  changedBeltIds: string[];
  applyMs: number;
  invalidationMs: number;
}

export interface RuntimeWorld {
  runtimeVersion: typeof RUNTIME_WORLD_VERSION;
  state: GameState;
  entities: RuntimeWorldSlotTable<FactoryEntity>;
  belts: RuntimeWorldSlotTable<BeltConnection>;
  entityDirty: RuntimeWorldDirtyBitset;
  beltDirty: RuntimeWorldDirtyBitset;
  domainRevisions: RuntimeWorldDomainRevisions;
  journal: RuntimeWorldJournal;
  projectionBaseline: SimulationProjectionBaseline;
  adapterRevision: number;
  committedRevision: number;
  lookupGeneration: number;
  projectionFallbacks: number;
  projectionMatches: number;
}

const ENTITY_LOOKUP_INVALIDATING_FIELDS = new Set([
  "id",
  "kind",
  "planetId",
  "resourceId",
  "buildingId",
  "extractorBuildingId",
  "recipeId",
  "storedItemId",
  "deliveryItemIds",
  "deliverySlots",
  "orbitalCargoPortItems",
  "orbitalCargoBinding",
  "distributionMode",
  "fuelItemId",
  "energyMode",
  "powerGridId",
  "powerPriority",
  "generationPriority",
  "stationMode",
  "stationTier",
  "stationOperationMode",
  "quantumMode",
  "elevatorOutputItems",
  "stationHubEnabled",
  "stationHubPriority",
  "stationMinimumLoad",
  "stationSlots",
  "sprayCoaterInstalled",
  "proliferatorTier",
  "proliferatorMode",
  "galacticExporterPaused",
  "blackHolePaused",
  "blackHolePorts",
  "machineCount",
  "minerCount",
]);

const BELT_LOOKUP_INVALIDATING_FIELDS = new Set([
  "id",
  "planetId",
  "source",
  "target",
  "itemId",
  "lanes",
  "tier",
  "sorterTier",
  "priority",
  "stackSize",
  "routeMode",
  "targetPortIndex",
  "elevatorOutputIndex",
]);

const TOP_LEVEL_LOOKUP_INVALIDATING_FIELDS = new Set([
  "version",
  "mode",
  "research",
  "exploration",
  "galaxy",
  "contentPacks",
  "dysonSwarm",
  "dysonSphere",
  "dysonEngineering",
  "systemSpaceStations",
  "galacticHubNetwork",
  "quantumLogisticsNetwork",
  "orbitalStation",
  "endgame",
]);

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function createDomainRevisions(): RuntimeWorldDomainRevisions {
  return Object.fromEntries(RUNTIME_WORLD_DOMAINS.map((domain) => [domain, 0])) as RuntimeWorldDomainRevisions;
}

function createSlotTable<T extends { id: string }>(records: readonly T[]): RuntimeWorldSlotTable<T> {
  return {
    slots: records.map((value, index) => ({ index, generation: 1, revision: 0, id: value.id, value })),
    byId: new Map(records.map((value, index) => [value.id, index])),
    free: [],
  };
}

function appendJournal(
  world: RuntimeWorld,
  entry: Omit<RuntimeWorldJournalEntry, "sequence">,
): void {
  const sequence = ++world.journal.sequence;
  world.journal.entries.push({ sequence, ...entry });
  const overflow = world.journal.entries.length - world.journal.maximumEntries;
  if (overflow <= 0) return;
  world.journal.entries.splice(0, overflow);
  world.journal.droppedEntries += overflow;
}

function invalidateDomains(world: RuntimeWorld, domains: Iterable<RuntimeWorldDomain>): RuntimeWorldDomain[] {
  const unique = [...new Set(domains)];
  for (const domain of unique) {
    world.domainRevisions[domain] += 1;
    appendJournal(world, { kind: "domain", operation: "invalidate", domains: [domain] });
  }
  return unique;
}

function slotReference<T extends { id: string }>(slot: RuntimeWorldSlot<T>): RuntimeWorldSlotReference {
  return { index: slot.index, generation: slot.generation };
}

function adoptRecord<T extends { id: string }>(target: T, source: T): T {
  const mutable = target as unknown as Record<string, unknown>;
  const next = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    if (!(key in next)) delete mutable[key];
  }
  for (const [key, value] of Object.entries(next)) mutable[key] = value;
  return target;
}

function markRecordChanged<T extends { id: string }>(
  world: RuntimeWorld,
  table: RuntimeWorldSlotTable<T>,
  dirty: RuntimeWorldDirtyBitset,
  kind: "entity" | "belt",
  id: string,
  domains: readonly RuntimeWorldDomain[],
  path?: readonly SimulationPatchPathSegment[],
): RuntimeWorldSlot<T> | undefined {
  const index = table.byId.get(id);
  if (index === undefined) return undefined;
  const slot = table.slots[index];
  slot.revision += 1;
  dirty.mark(index);
  appendJournal(world, {
    kind,
    operation: "update",
    id,
    slot: slotReference(slot),
    path,
    domains,
  });
  return slot;
}

function recordRoot(change: SimulationValuePatch): string {
  const root = change.path[0];
  return typeof root === "string" ? root : "";
}

function recordDomains(kind: "entity" | "belt", change: SimulationValuePatch): RuntimeWorldDomain[] {
  const root = recordRoot(change);
  if (kind === "belt") {
    if (BELT_LOOKUP_INVALIDATING_FIELDS.has(root)) return ["beltTopology", "production", "logistics", "projection"];
    return ["statistics", "projection"];
  }
  if (root === "powerGridId" || root === "powerPriority" || root === "generationPriority") {
    return ["power", "production", "beltTopology", "projection"];
  }
  if (root === "recipeId" || root === "buildingId" || root === "machineCount" || root === "minerCount") {
    return ["production", "power", "beltTopology", "projection"];
  }
  if (root.startsWith("station") || root.startsWith("quantum") || root === "deliverySlots" || root === "deliveryItemIds" ||
    root === "orbitalCargoBinding" || root === "orbitalCargoPortItems") {
    return ["logistics", "quantum", "projection"];
  }
  if (ENTITY_LOOKUP_INVALIDATING_FIELDS.has(root)) {
    return ["entityTopology", "production", "power", "logistics", "quantum", "projection"];
  }
  return ["statistics", "projection"];
}

function commandInvalidations(patch: SimulationCommandPatch): {
  domains: RuntimeWorldDomain[];
  lookupInvalidated: boolean;
} {
  const domains = new Set<RuntimeWorldDomain>(["adapter", "projection"]);
  let lookupInvalidated = patch.addedEntities.length > 0 || patch.removedEntityIds.length > 0 ||
    patch.addedBelts.length > 0 || patch.removedBeltIds.length > 0;
  if (patch.addedEntities.length > 0 || patch.removedEntityIds.length > 0) {
    for (const domain of ["entityTopology", "production", "power", "logistics", "quantum"] as const) domains.add(domain);
  }
  if (patch.addedBelts.length > 0 || patch.removedBeltIds.length > 0) {
    for (const domain of ["beltTopology", "production", "logistics"] as const) domains.add(domain);
  }
  for (const change of patch.topLevelChanges) {
    const root = recordRoot(change);
    if (TOP_LEVEL_LOOKUP_INVALIDATING_FIELDS.has(root)) {
      lookupInvalidated = true;
      for (const domain of ["production", "power", "logistics", "quantum"] as const) domains.add(domain);
    } else {
      domains.add(root === "totalProduced" || root === "productionHistory" ? "statistics" : "adapter");
    }
  }
  for (const record of patch.changedEntities) {
    for (const change of record.changes) {
      const affected = recordDomains("entity", change);
      affected.forEach((domain) => domains.add(domain));
      if (ENTITY_LOOKUP_INVALIDATING_FIELDS.has(recordRoot(change))) lookupInvalidated = true;
    }
  }
  for (const record of patch.changedBelts) {
    for (const change of record.changes) {
      const affected = recordDomains("belt", change);
      affected.forEach((domain) => domains.add(domain));
      if (BELT_LOOKUP_INVALIDATING_FIELDS.has(recordRoot(change))) lookupInvalidated = true;
    }
  }
  return { domains: [...domains], lookupInvalidated };
}

function synchronizeSlotTable<T extends { id: string }>(
  world: RuntimeWorld,
  table: RuntimeWorldSlotTable<T>,
  records: T[],
  dirty: RuntimeWorldDirtyBitset,
  kind: "entity" | "belt",
  domains: readonly RuntimeWorldDomain[],
): void {
  const present = new Set(records.map((record) => record.id));
  for (const [id, index] of [...table.byId]) {
    if (present.has(id)) continue;
    const slot = table.slots[index];
    table.byId.delete(id);
    slot.id = null;
    slot.value = null;
    slot.generation += 1;
    slot.revision += 1;
    table.free.push(index);
    dirty.mark(index);
    appendJournal(world, { kind, operation: "remove", id, slot: slotReference(slot), domains });
  }
  for (const record of records) {
    const existing = table.byId.get(record.id);
    if (existing !== undefined) {
      const slot = table.slots[existing];
      slot.value = record;
      continue;
    }
    const index = table.free.pop() ?? table.slots.length;
    const previous = table.slots[index];
    const slot: RuntimeWorldSlot<T> = previous
      ? { ...previous, id: record.id, value: record, revision: previous.revision + 1 }
      : { index, generation: 1, revision: 1, id: record.id, value: record };
    table.slots[index] = slot;
    table.byId.set(record.id, index);
    dirty.mark(index);
    appendJournal(world, { kind, operation: "add", id: record.id, slot: slotReference(slot), domains });
  }
}

export function createRuntimeWorld(state: GameState, options: { maximumJournalEntries?: number } = {}): RuntimeWorld {
  return {
    runtimeVersion: RUNTIME_WORLD_VERSION,
    state,
    entities: createSlotTable(state.entities),
    belts: createSlotTable(state.belts),
    entityDirty: new RuntimeWorldDirtyBitset(),
    beltDirty: new RuntimeWorldDirtyBitset(),
    domainRevisions: createDomainRevisions(),
    journal: {
      sequence: 0,
      entries: [],
      maximumEntries: Math.max(128, Math.floor(options.maximumJournalEntries ?? 8_192)),
      droppedEntries: 0,
    },
    projectionBaseline: captureSimulationProjectionBaseline(state),
    adapterRevision: 0,
    committedRevision: 0,
    lookupGeneration: 1,
    projectionFallbacks: 0,
    projectionMatches: 0,
  };
}

export function resolveRuntimeWorldSlot<T extends { id: string }>(
  table: RuntimeWorldSlotTable<T>,
  reference: RuntimeWorldSlotReference,
): T | undefined {
  const slot = table.slots[reference.index];
  return slot && slot.generation === reference.generation ? slot.value ?? undefined : undefined;
}

/** Replace the compatibility adapter after checkpoint/registry adoption. */
export function replaceRuntimeWorldState(world: RuntimeWorld, state: GameState): void {
  world.state = state;
  synchronizeSlotTable(world, world.entities, state.entities, world.entityDirty, "entity", ["entityTopology", "projection"]);
  synchronizeSlotTable(world, world.belts, state.belts, world.beltDirty, "belt", ["beltTopology", "projection"]);
  world.adapterRevision += 1;
  world.lookupGeneration += 1;
  invalidateDomains(world, RUNTIME_WORLD_DOMAINS);
  world.projectionBaseline = captureSimulationProjectionBaseline(state);
}

/**
 * Apply a UI patch while retaining record/array identity whenever the lookup
 * stores only references to those records. Structural leaves invalidate an
 * explicit domain and let the compatibility runtime rebuild at the boundary.
 */
export function applyRuntimeWorldCommand(
  world: RuntimeWorld,
  patch: SimulationCommandPatch,
  profiler?: SimulationProfiler,
): RuntimeWorldCommandResult {
  if (patch.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`不支持的模拟命令协议 ${patch.protocolVersion}`);
  }
  const invalidationStartedAt = profiler ? now() : 0;
  const invalidation = commandInvalidations(patch);
  const invalidationClassifyMs = profiler ? Math.max(0, now() - invalidationStartedAt) : 0;
  const applyStartedAt = profiler ? now() : 0;
  const previous = world.state;
  const changedEntityIds = patch.changedEntities.map((record) => record.id);
  const changedBeltIds = patch.changedBelts.map((record) => record.id);
  const arrayTopologyChanged = patch.addedEntities.length > 0 || patch.removedEntityIds.length > 0 ||
    patch.addedBelts.length > 0 || patch.removedBeltIds.length > 0;

  let state: GameState;
  if (arrayTopologyChanged) {
    state = applySimulationCommandPatch(previous, patch);
    synchronizeSlotTable(world, world.entities, state.entities, world.entityDirty, "entity", invalidation.domains);
    synchronizeSlotTable(world, world.belts, state.belts, world.beltDirty, "belt", invalidation.domains);
    for (const record of patch.changedEntities) {
      markRecordChanged(world, world.entities, world.entityDirty, "entity", record.id, invalidation.domains);
    }
    for (const record of patch.changedBelts) {
      markRecordChanged(world, world.belts, world.beltDirty, "belt", record.id, invalidation.domains);
    }
  } else {
    let topLevel: unknown = previous;
    for (const change of patch.topLevelChanges) topLevel = applySimulationValuePatch(topLevel, change);
    state = {
      ...(topLevel as GameState),
      entities: previous.entities,
      belts: previous.belts,
    };
    for (const record of patch.changedEntities) {
      const index = world.entities.byId.get(record.id);
      const slot = index === undefined ? undefined : world.entities.slots[index];
      if (!slot?.value) throw new Error(`RuntimeWorld entity slot missing: ${record.id}`);
      const next = record.changes.reduce(
        (value, change) => applySimulationValuePatch(value, change) as FactoryEntity,
        slot.value,
      );
      adoptRecord(slot.value, next);
      for (const change of record.changes) {
        markRecordChanged(world, world.entities, world.entityDirty, "entity", record.id, recordDomains("entity", change), change.path);
      }
    }
    for (const record of patch.changedBelts) {
      const index = world.belts.byId.get(record.id);
      const slot = index === undefined ? undefined : world.belts.slots[index];
      if (!slot?.value) throw new Error(`RuntimeWorld belt slot missing: ${record.id}`);
      const next = record.changes.reduce(
        (value, change) => applySimulationValuePatch(value, change) as BeltConnection,
        slot.value,
      );
      adoptRecord(slot.value, next);
      for (const change of record.changes) {
        markRecordChanged(world, world.belts, world.beltDirty, "belt", record.id, recordDomains("belt", change), change.path);
      }
    }
  }
  const applyMs = profiler ? Math.max(0, now() - applyStartedAt) : 0;
  if (invalidation.lookupInvalidated) {
    world.lookupGeneration += 1;
  }
  for (const change of patch.topLevelChanges) {
    appendJournal(world, { kind: "top-level", operation: "update", path: change.path, domains: invalidation.domains });
  }
  world.state = state;
  world.adapterRevision += 1;
  const invalidationCommitStartedAt = profiler ? now() : 0;
  const invalidatedDomains = invalidateDomains(world, invalidation.domains);
  const invalidationMs = profiler
    ? invalidationClassifyMs + Math.max(0, now() - invalidationCommitStartedAt)
    : 0;
  if (profiler) {
    profiler.commandApplyMs += applyMs;
    profiler.domainInvalidationMs += invalidationMs;
  }
  return {
    state,
    lookupInvalidated: invalidation.lookupInvalidated,
    invalidatedDomains,
    changedEntityIds,
    changedBeltIds,
    applyMs,
    invalidationMs,
  };
}

function projectionDifference(left: unknown, right: unknown, path = "$", visited = new WeakMap<object, object>()): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") return path;
  const leftObject = left as object;
  const rightObject = right as object;
  if (visited.get(leftObject) === rightObject) return undefined;
  visited.set(leftObject, rightObject);
  if (Array.isArray(left) !== Array.isArray(right)) return path;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = projectionDifference(left[index], right[index], `${path}[${index}]`, visited);
      if (difference) return difference;
    }
    return undefined;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return `${path}.[keys]`;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return `${path}.${key}`;
    const difference = projectionDifference(leftRecord[key], rightRecord[key], `${path}.${key}`, visited);
    if (difference) return difference;
  }
  return undefined;
}

/**
 * Reconcile legacy-mutated records into the stable slot tables, derive a
 * projection from exact changed-id candidates, and optionally shadow it with
 * an unrestricted Projection v2 scan. The caller only publishes the selected
 * projection, so a mismatch cannot escape the Worker boundary.
 */
export function commitRuntimeWorldProjection(
  world: RuntimeWorld,
  state: GameState,
  options: {
    compact?: boolean;
    includeDeferredTopLevel?: boolean;
    compareWithProjectionV2?: boolean;
  } = {},
  profiler?: SimulationProfiler,
): RuntimeWorldProjectionResult {
  const journalStartedAt = profiler ? now() : 0;
  const baseline = world.projectionBaseline;
  const activePlanetChanged = baseline.activePlanetId !== state.activePlanetId;
  synchronizeSlotTable(world, world.entities, state.entities, world.entityDirty, "entity", ["entityTopology", "projection"]);
  synchronizeSlotTable(world, world.belts, state.belts, world.beltDirty, "belt", ["beltTopology", "projection"]);

  const entityCandidates = new Set<string>();
  const beltCandidates = new Set<string>();
  const currentPlanetEntityIds = new Set<string>();
  const currentPlanetBeltIds = new Set<string>();
  for (const entity of state.entities) {
    if (entity.planetId !== state.activePlanetId) continue;
    currentPlanetEntityIds.add(entity.id);
    if (activePlanetChanged || baseline.entitySignatures.get(entity.id) !== JSON.stringify(entity)) {
      entityCandidates.add(entity.id);
      const index = world.entities.byId.get(entity.id);
      if (index !== undefined && !world.entityDirty.has(index)) {
        markRecordChanged(world, world.entities, world.entityDirty, "entity", entity.id, ["projection", "statistics"]);
      }
    }
  }
  for (const id of baseline.entitySignatures.keys()) {
    if (!currentPlanetEntityIds.has(id)) entityCandidates.add(id);
  }
  for (const belt of state.belts) {
    if (belt.planetId !== state.activePlanetId) continue;
    currentPlanetBeltIds.add(belt.id);
    if (activePlanetChanged || baseline.beltSignatures.get(belt.id) !== JSON.stringify(belt)) {
      beltCandidates.add(belt.id);
      const index = world.belts.byId.get(belt.id);
      if (index !== undefined && !world.beltDirty.has(index)) {
        markRecordChanged(world, world.belts, world.beltDirty, "belt", belt.id, ["projection", "statistics"]);
      }
    }
  }
  for (const id of baseline.beltSignatures.keys()) {
    if (!currentPlanetBeltIds.has(id)) beltCandidates.add(id);
  }
  const journalMs = profiler ? Math.max(0, now() - journalStartedAt) : 0;
  const projectionStartedAt = profiler ? now() : 0;
  const journalProjection = createSimulationProjection(baseline, state, {
    compact: options.compact,
    includeDeferredTopLevel: options.includeDeferredTopLevel,
    candidateEntityIds: entityCandidates,
    candidateBeltIds: beltCandidates,
    trustCandidateIds: true,
  });
  let projection = journalProjection;
  let mismatchPath: string | undefined;
  if (options.compareWithProjectionV2) {
    const legacyProjection = createSimulationProjection(baseline, state, {
      compact: options.compact,
      includeDeferredTopLevel: options.includeDeferredTopLevel,
    });
    mismatchPath = projectionDifference(journalProjection, legacyProjection);
    if (mismatchPath) {
      projection = legacyProjection;
      world.projectionFallbacks += 1;
    } else {
      world.projectionMatches += 1;
    }
  }
  if (profiler) {
    profiler.journalMs += journalMs;
    profiler.projectionMs += Math.max(0, now() - projectionStartedAt);
  }
  world.state = state;
  world.projectionBaseline = captureSimulationProjectionBaseline(state, {
    includeDeferredTopLevel: options.includeDeferredTopLevel,
  });
  world.entityDirty.clear();
  world.beltDirty.clear();
  world.committedRevision += 1;
  return {
    projection,
    journalProjection,
    diagnostics: {
      source: mismatchPath ? "projection-v2-fallback" : "journal",
      comparedWithProjectionV2: options.compareWithProjectionV2 === true,
      matchedProjectionV2: options.compareWithProjectionV2 === true && !mismatchPath,
      mismatchPath,
      candidateEntityCount: entityCandidates.size,
      candidateBeltCount: beltCandidates.size,
    },
  };
}

export function runtimeWorldJournalSince(world: RuntimeWorld, sequence: number): RuntimeWorldJournalEntry[] {
  return world.journal.entries.filter((entry) => entry.sequence > sequence);
}
