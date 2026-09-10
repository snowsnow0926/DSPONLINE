import {
  commitLocalSaveInternalRecords,
  listLocalSaveInternalKeys,
  LOCAL_SAVE_INTERNAL_PREFIX,
  readLocalSaveInternalValue,
  type LocalSaveInternalWrite,
} from "./localSaveStore";
import { computeSaveStateChecksum, inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import { createPersistentSaveProjectionParts } from "./saveProjection";
import type { ContentPackRegistry } from "./contentPacks";
import type { GameState, SaveMode } from "./types";

/** Internal v1 sidecar format. The public envelope remains format v2/state v47. */
export const CHUNKED_SAVE_FORMAT_VERSION = 1;
export const CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION = 2;
export const CHUNKED_ENTITY_SIZE = 1_024;
export const CHUNKED_BELT_SIZE = 2_048;

export interface ChunkedSaveChunkMetadata {
  id: string;
  kind: "base" | "entities" | "belts";
  offset: number;
  count: number;
  checksum: string;
  bytes: number;
}

export interface ChunkedSaveManifest {
  formatVersion: 1;
  envelopeFormatVersion: 2;
  mode: SaveMode;
  slot: "main";
  stateVersion: number;
  savedAt: number;
  basePrimaryChecksum: string;
  chunkRootChecksum: string;
  totalBytes: number;
  entityCount: number;
  beltCount: number;
  chunks: ChunkedSaveChunkMetadata[];
}

export interface ChunkedSaveBuildResult {
  manifest: ChunkedSaveManifest;
  chunks: ReadonlyMap<string, string>;
  changedChunkIds: string[];
  changedBytes: number;
  totalBytes: number;
  projectedState: GameState;
}

export interface ChunkedSavePartsBuildResult extends Omit<ChunkedSaveBuildResult, "projectedState"> {}

export interface PersistChunkedSaveOptions {
  mode: SaveMode;
  basePrimaryChecksum: string;
  savedAt?: number;
}

export interface PersistChunkedSaveResult {
  success: true;
  changedChunks: number;
  changedBytes: number;
  totalBytes: number;
  chunkCount: number;
  savedAt: number;
  manifest: ChunkedSaveManifest;
}

export interface ChunkedSaveJournalContext {
  mode: SaveMode;
  basePrimaryChecksum: string;
  previous: ChunkedSaveManifest | null;
  previousChunkIds: string[];
  existingKeys: string[];
}

export interface ChunkedSaveJournalCommit {
  context: Pick<ChunkedSaveJournalContext, "mode" | "basePrimaryChecksum"> & {
    previousChunkRootChecksum: string | null;
  };
  writes: LocalSaveInternalWrite[];
  result: PersistChunkedSaveResult;
}

export interface RestoredChunkedSave {
  raw: string;
  manifest: ChunkedSaveManifest;
}

export interface ChunkedSaveCollectionReuse {
  entityCount: number;
  beltCount: number;
  chunks: readonly ChunkedSaveChunkMetadata[];
}

function journalPrefix(mode: SaveMode): string {
  return `${LOCAL_SAVE_INTERNAL_PREFIX}chunked.v1.${mode}.`;
}

function manifestKey(mode: SaveMode): string {
  return `${journalPrefix(mode)}manifest`;
}

function chunkKey(mode: SaveMode, id: string): string {
  return `${journalPrefix(mode)}chunk.${encodeURIComponent(id)}`;
}

function chunkRootChecksum(chunks: readonly ChunkedSaveChunkMetadata[]): string {
  const material = chunks.map((chunk) => `${chunk.id}:${chunk.kind}:${chunk.offset}:${chunk.count}:${chunk.checksum}:${chunk.bytes};`).join("");
  return computeSavePayloadTextChecksum(material).checksum;
}

function parseManifest(raw: string | null): ChunkedSaveManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChunkedSaveManifest>;
    const totalBytes = value.totalBytes;
    const entityCount = value.entityCount;
    const beltCount = value.beltCount;
    if (totalBytes === undefined || entityCount === undefined || beltCount === undefined) return null;
    if (value.formatVersion !== CHUNKED_SAVE_FORMAT_VERSION || value.envelopeFormatVersion !== CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION ||
      (value.mode !== "normal" && value.mode !== "speedrun") || value.slot !== "main" ||
      !Number.isSafeInteger(value.stateVersion) || !Number.isSafeInteger(value.savedAt) ||
      typeof value.basePrimaryChecksum !== "string" || !/^[0-9a-f]{8}$/.test(value.basePrimaryChecksum) ||
      typeof value.chunkRootChecksum !== "string" || !/^[0-9a-f]{8}$/.test(value.chunkRootChecksum) ||
      !Number.isSafeInteger(totalBytes) || totalBytes < 0 ||
      !Number.isSafeInteger(entityCount) || entityCount < 0 ||
      !Number.isSafeInteger(beltCount) || beltCount < 0 || !Array.isArray(value.chunks)) return null;
    const chunks = value.chunks.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const chunk = candidate as Partial<ChunkedSaveChunkMetadata>;
      const offset = chunk.offset;
      const count = chunk.count;
      const bytes = chunk.bytes;
      if (typeof chunk.id !== "string" || (chunk.kind !== "base" && chunk.kind !== "entities" && chunk.kind !== "belts") ||
        offset === undefined || !Number.isSafeInteger(offset) || offset < 0 || count === undefined || !Number.isSafeInteger(count) || count < 0 ||
        typeof chunk.checksum !== "string" || !/^[0-9a-f]{8}$/.test(chunk.checksum) ||
        bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return [];
      return [{ id: chunk.id, kind: chunk.kind, offset, count, checksum: chunk.checksum, bytes }];
    });
    if (chunks.length !== value.chunks.length || chunks.length === 0 || chunks.filter((chunk) => chunk.kind === "base").length !== 1) return null;
    if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) return null;
    const manifest = { ...value, totalBytes, entityCount, beltCount, chunks } as ChunkedSaveManifest;
    return chunkRootChecksum(chunks) === manifest.chunkRootChecksum ? manifest : null;
  } catch {
    return null;
  }
}

function makeChunk(
  id: string,
  kind: ChunkedSaveChunkMetadata["kind"],
  offset: number,
  values: unknown,
): { metadata: ChunkedSaveChunkMetadata; text: string } {
  const text = JSON.stringify(values);
  const identity = computeSavePayloadTextChecksum(text);
  return {
    metadata: { id, kind, offset, count: Array.isArray(values) ? values.length : 1, checksum: identity.checksum, bytes: identity.byteLength },
    text,
  };
}

function visitProjectedParts(
  projectedState: GameState,
  visit: (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => void,
): void {
  const { entities, belts, ...base } = projectedState as GameState & { entities: unknown[]; belts: unknown[] };
  visit(makeChunk("base", "base", 0, base));
  const visitArray = (values: readonly unknown[], kind: "entities" | "belts", size: number) => {
    let visited = false;
    for (let offset = 0; offset < values.length; offset += size) {
      visited = true;
      visit(makeChunk(`${kind}:${String(offset).padStart(8, "0")}`, kind, offset, values.slice(offset, offset + size)));
    }
    // Empty arrays still need a deterministic chunk so a manifest can be
    // reconstructed without guessing whether a field was omitted.
    if (!visited) visit(makeChunk(`${kind}:00000000`, kind, 0, []));
  };
  visitArray(entities, "entities", CHUNKED_ENTITY_SIZE);
  visitArray(belts, "belts", CHUNKED_BELT_SIZE);
}

function visitRuntimeProjectionParts(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
  visit: (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => void,
): { stateVersion: number; entityCount: number; beltCount: number } {
  const projection = createPersistentSaveProjectionParts(state, contentPackRegistry);
  visit(makeChunk("base", "base", 0, projection.base));
  const visitRanges = (
    total: number,
    kind: "entities" | "belts",
    size: number,
    project: (offset: number, count: number) => unknown[],
  ) => {
    let visited = false;
    for (let offset = 0; offset < total; offset += size) {
      visited = true;
      visit(makeChunk(`${kind}:${String(offset).padStart(8, "0")}`, kind, offset, project(offset, size)));
    }
    if (!visited) visit(makeChunk(`${kind}:00000000`, kind, 0, []));
  };
  visitRanges(projection.entityCount, "entities", CHUNKED_ENTITY_SIZE, projection.projectEntityRange);
  visitRanges(projection.beltCount, "belts", CHUNKED_BELT_SIZE, projection.projectBeltRange);
  return {
    stateVersion: projection.base.version,
    entityCount: projection.entityCount,
    beltCount: projection.beltCount,
  };
}

function buildChunkedSaveJournalParts(
  identity: { stateVersion: number; entityCount: number; beltCount: number },
  options: { mode: SaveMode; basePrimaryChecksum: string; savedAt?: number; previous?: ChunkedSaveManifest | null; previousChunkTexts?: ReadonlyMap<string, string>; previousChunkIds?: ReadonlySet<string>; retainAllChunks?: boolean },
  visitParts: (visit: (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => void) => void,
): ChunkedSavePartsBuildResult {
  const metadata: ChunkedSaveChunkMetadata[] = [];
  const chunks = new Map<string, string>();
  const previous = options.previous ?? null;
  const previousById = new Map(previous?.chunks.map((chunk) => [chunk.id, chunk]) ?? []);
  const changedChunkIds: string[] = [];
  const changedChunkSet = new Set<string>();
  let changedBytes = 0;
  visitParts((part) => {
    metadata.push(part.metadata);
    const old = previousById.get(part.metadata.id);
    const oldText = options.previousChunkTexts?.get(part.metadata.id);
    // A missing old text must be rewritten even if a stale manifest happens
    // to report the same checksum.
    const knownPreviousChunk = oldText !== undefined || options.previousChunkIds?.has(part.metadata.id) === true;
    if (!old || old.checksum !== part.metadata.checksum || !knownPreviousChunk) {
      changedChunkIds.push(part.metadata.id);
      changedChunkSet.add(part.metadata.id);
      changedBytes += part.metadata.bytes;
    }
    if (options.retainAllChunks !== false || changedChunkSet.has(part.metadata.id)) chunks.set(part.metadata.id, part.text);
  });
  const manifest: ChunkedSaveManifest = {
    formatVersion: CHUNKED_SAVE_FORMAT_VERSION,
    envelopeFormatVersion: CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION,
    mode: options.mode,
    slot: "main",
    stateVersion: identity.stateVersion,
    savedAt: options.savedAt ?? Date.now(),
    basePrimaryChecksum: options.basePrimaryChecksum,
    chunkRootChecksum: chunkRootChecksum(metadata),
    totalBytes: metadata.reduce((sum, chunk) => sum + chunk.bytes, 0),
    entityCount: identity.entityCount,
    beltCount: identity.beltCount,
    chunks: metadata,
  };
  return { manifest, chunks, changedChunkIds, changedBytes, totalBytes: manifest.totalBytes };
}

export function buildChunkedSaveJournal(
  projectedState: GameState,
  options: { mode: SaveMode; basePrimaryChecksum: string; savedAt?: number; previous?: ChunkedSaveManifest | null; previousChunkTexts?: ReadonlyMap<string, string>; previousChunkIds?: ReadonlySet<string>; retainAllChunks?: boolean },
): ChunkedSaveBuildResult {
  return {
    ...buildChunkedSaveJournalParts(
      {
        stateVersion: projectedState.version,
        entityCount: projectedState.entities.length,
        beltCount: projectedState.belts.length,
      },
      options,
      (visit) => visitProjectedParts(projectedState, visit),
    ),
    projectedState,
  };
}

function assembleState(manifest: ChunkedSaveManifest, values: ReadonlyMap<string, string>): GameState | null {
  const baseMeta = manifest.chunks.find((chunk) => chunk.kind === "base");
  if (!baseMeta) return null;
  let base: Record<string, unknown>;
  try {
    const baseText = values.get(baseMeta.id) ?? "";
    const baseIdentity = computeSavePayloadTextChecksum(baseText);
    if (baseIdentity.checksum !== baseMeta.checksum || baseIdentity.byteLength !== baseMeta.bytes || baseMeta.count !== 1) return null;
    const parsed = JSON.parse(baseText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    base = parsed as Record<string, unknown>;
  } catch { return null; }
  const entities = new Array<unknown>(manifest.entityCount);
  const belts = new Array<unknown>(manifest.beltCount);
  const ranges: Array<{ target: unknown[]; metadata: ChunkedSaveChunkMetadata }> = [];
  for (const metadata of manifest.chunks) {
    if (metadata.kind === "base") continue;
    const target = metadata.kind === "entities" ? entities : belts;
    if (metadata.offset + metadata.count > target.length) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(values.get(metadata.id) ?? "null"); } catch { return null; }
    if (!Array.isArray(parsed) || parsed.length !== metadata.count) return null;
    const actual = computeSavePayloadTextChecksum(values.get(metadata.id) ?? "");
    if (actual.checksum !== metadata.checksum || actual.byteLength !== metadata.bytes) return null;
    ranges.push({ target, metadata });
    for (let index = 0; index < parsed.length; index += 1) {
      if (target[metadata.offset + index] !== undefined) return null;
      target[metadata.offset + index] = parsed[index];
    }
  }
  if (entities.some((entry) => entry === undefined) || belts.some((entry) => entry === undefined)) return null;
  if (!ranges.length && (entities.length > 0 || belts.length > 0)) return null;
  return { ...base, entities, belts } as GameState;
}

function buildEnvelope(state: GameState, manifest: ChunkedSaveManifest): string {
  const checksum = computeSaveStateChecksum(CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION, state);
  return JSON.stringify({
    formatVersion: CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION,
    kind: "primary",
    mode: manifest.mode,
    slot: "main",
    savedAt: manifest.savedAt,
    state,
    checksum,
  });
}

export async function prepareChunkedSaveJournalContext(
  mode: SaveMode,
  basePrimaryChecksum: string,
): Promise<ChunkedSaveJournalContext> {
  const previous = parseManifest(await readLocalSaveInternalValue(manifestKey(mode)));
  const existingKeys = await listLocalSaveInternalKeys(journalPrefix(mode));
  const matchingPrevious = previous?.basePrimaryChecksum === basePrimaryChecksum ? previous : null;
  const existingKeySet = new Set(existingKeys);
  const previousChunkIds = matchingPrevious?.chunks
    .filter((chunk) => existingKeySet.has(chunkKey(mode, chunk.id)))
    .map((chunk) => chunk.id) ?? [];
  return { mode, basePrimaryChecksum, previous: matchingPrevious, previousChunkIds, existingKeys };
}

function buildChunkedSaveJournalCommitParts(
  identity: { stateVersion: number; entityCount: number; beltCount: number },
  options: PersistChunkedSaveOptions,
  context: ChunkedSaveJournalContext,
  visitParts: (visit: (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => void) => void,
): ChunkedSaveJournalCommit {
  if (context.mode !== options.mode || context.basePrimaryChecksum !== options.basePrimaryChecksum) {
    throw new Error("分块保存上下文与主存档身份不一致");
  }
  const previousChunkIds = new Set(context.previousChunkIds);
  const build = buildChunkedSaveJournalParts(identity, {
    mode: options.mode,
    basePrimaryChecksum: options.basePrimaryChecksum,
    savedAt: options.savedAt,
    previous: context.previous,
    previousChunkIds,
    retainAllChunks: false,
  }, visitParts);
  const staleKeys = context.existingKeys.filter((key) =>
    key !== manifestKey(options.mode) && !build.manifest.chunks.some((chunk) => key === chunkKey(options.mode, chunk.id)));
  const writes: LocalSaveInternalWrite[] = [];
  for (const id of build.changedChunkIds) writes.push({ key: chunkKey(options.mode, id), value: build.chunks.get(id)! });
  for (const key of staleKeys) writes.push({ key, value: null });
  // Manifest is intentionally last in the transaction.
  writes.push({ key: manifestKey(options.mode), value: JSON.stringify(build.manifest) });
  return {
    context: {
      mode: options.mode,
      basePrimaryChecksum: options.basePrimaryChecksum,
      previousChunkRootChecksum: context.previous?.chunkRootChecksum ?? null,
    },
    writes,
    result: {
      success: true,
      changedChunks: build.changedChunkIds.length,
      changedBytes: build.changedBytes,
      totalBytes: build.totalBytes,
      chunkCount: build.manifest.chunks.length,
      savedAt: build.manifest.savedAt,
      manifest: build.manifest,
    },
  };
}

export async function commitChunkedSaveJournal(
  commit: ChunkedSaveJournalCommit,
): Promise<PersistChunkedSaveResult> {
  const currentIdentity = await prepareChunkedSaveJournalContext(commit.context.mode, commit.context.basePrimaryChecksum);
  // A newer sidecar commit must never be overwritten by a build produced from
  // an older manifest while another async boundary was in flight.
  const expectedManifest = commit.result.manifest;
  const previousRoot = currentIdentity.previous?.chunkRootChecksum ?? null;
  const builtFromRoot = (() => {
    const manifestWrite = commit.writes.at(-1)?.value;
    if (!manifestWrite) return null;
    try {
      const parsed = JSON.parse(manifestWrite) as ChunkedSaveManifest;
      return parsed.chunkRootChecksum === expectedManifest.chunkRootChecksum ? parsed : null;
    } catch { return null; }
  })();
  if (!builtFromRoot || currentIdentity.basePrimaryChecksum !== commit.context.basePrimaryChecksum ||
    previousRoot !== commit.context.previousChunkRootChecksum) {
    throw new Error("分块保存提交清单校验失败");
  }
  await commitLocalSaveInternalRecords(commit.writes);
  return commit.result;
}

export async function persistChunkedSaveJournal(
  projectedState: GameState,
  options: PersistChunkedSaveOptions,
): Promise<PersistChunkedSaveResult> {
  const context = await prepareChunkedSaveJournalContext(options.mode, options.basePrimaryChecksum);
  const commit = buildChunkedSaveJournalCommit(projectedState, options, context);
  return commitChunkedSaveJournal(commit);
}

export function buildChunkedSaveJournalCommit(
  projectedState: GameState,
  options: PersistChunkedSaveOptions,
  context: ChunkedSaveJournalContext,
): ChunkedSaveJournalCommit {
  return buildChunkedSaveJournalCommitParts(
    {
      stateVersion: projectedState.version,
      entityCount: projectedState.entities.length,
      beltCount: projectedState.belts.length,
    },
    options,
    context,
    (visit) => visitProjectedParts(projectedState, visit),
  );
}

/**
 * Persist the sidecar directly from Worker-owned authority. Only one bounded
 * record page and the changed chunk strings are alive at once; no full JSON
 * transfer or decoded mirror is created.
 */
export async function persistChunkedSaveJournalFromRuntimeState(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
  options: PersistChunkedSaveOptions,
): Promise<PersistChunkedSaveResult> {
  const context = await prepareChunkedSaveJournalContext(options.mode, options.basePrimaryChecksum);
  const commit = buildChunkedSaveJournalCommitFromRuntimeState(state, contentPackRegistry, options, context);
  return commitChunkedSaveJournal(commit);
}

export function buildChunkedSaveJournalCommitFromRuntimeState(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
  options: PersistChunkedSaveOptions,
  context: ChunkedSaveJournalContext,
): ChunkedSaveJournalCommit {
  const visitParts = (visit: (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => void) => {
    visitRuntimeProjectionParts(state, contentPackRegistry, visit);
  };
  const projectedIdentity = { stateVersion: state.version, entityCount: state.entities.length, beltCount: state.belts.length };
  return buildChunkedSaveJournalCommitParts(projectedIdentity, options, context, visitParts);
}

const STREAMING_SAVE_WRITE_BATCH_SIZE = 8;

/**
 * Project and durably write a large authority in bounded batches. The caller
 * supplies the page-owned writer callback, normally bridged over a
 * back-pressured MessagePort from the Simulation Worker. The old manifest is
 * left in place until every changed chunk has been acknowledged; if the page
 * dies mid-stream, checksum validation ignores the incomplete sidecar and the
 * compatible full primary remains recoverable.
 */
export async function streamChunkedSaveJournalFromRuntimeState(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
  options: PersistChunkedSaveOptions,
  context: ChunkedSaveJournalContext,
  writeBatch: (records: LocalSaveInternalWrite[]) => Promise<void>,
  collectionReuse?: ChunkedSaveCollectionReuse,
): Promise<PersistChunkedSaveResult> {
  if (context.mode !== options.mode || context.basePrimaryChecksum !== options.basePrimaryChecksum) {
    throw new Error("流式分块保存上下文与主存档身份不一致");
  }
  const projection = createPersistentSaveProjectionParts(state, contentPackRegistry);
  const previousById = new Map(context.previous?.chunks.map((chunk) => [chunk.id, chunk]) ?? []);
  const previousChunkIds = new Set(context.previousChunkIds);
  const metadata: ChunkedSaveChunkMetadata[] = [];
  const changedChunkIds: string[] = [];
  const pendingWrites: LocalSaveInternalWrite[] = [];
  let changedBytes = 0;
  const flush = async () => {
    if (pendingWrites.length === 0) return;
    const records = pendingWrites.splice(0, pendingWrites.length);
    await writeBatch(records);
  };
  const consume = async (part: { metadata: ChunkedSaveChunkMetadata; text: string }) => {
    metadata.push(part.metadata);
    const previous = previousById.get(part.metadata.id);
    if (previous && previous.checksum === part.metadata.checksum && previousChunkIds.has(part.metadata.id)) return;
    changedChunkIds.push(part.metadata.id);
    changedBytes += part.metadata.bytes;
    pendingWrites.push({ key: chunkKey(options.mode, part.metadata.id), value: part.text });
    if (pendingWrites.length >= STREAMING_SAVE_WRITE_BATCH_SIZE) await flush();
  };
  await consume(makeChunk("base", "base", 0, projection.base));
  const consumeRanges = async (
    total: number,
    kind: "entities" | "belts",
    size: number,
    project: (offset: number, count: number) => unknown[],
  ) => {
    if (total === 0) {
      await consume(makeChunk(`${kind}:00000000`, kind, 0, []));
      return;
    }
    for (let offset = 0; offset < total; offset += size) {
      await consume(makeChunk(`${kind}:${String(offset).padStart(8, "0")}`, kind, offset, project(offset, size)));
    }
  };
  const reusableChunks = collectionReuse?.entityCount === projection.entityCount &&
    collectionReuse.beltCount === projection.beltCount
    ? [...collectionReuse.chunks]
    : [];
  const reusableByKind = (kind: "entities" | "belts", total: number, size: number) => {
    const chunks = reusableChunks.filter((chunk) => chunk.kind === kind)
      .sort((left, right) => left.offset - right.offset);
    let offset = 0;
    for (const chunk of chunks) {
      const expectedCount = total === 0 ? 0 : Math.min(size, total - offset);
      const previous = previousById.get(chunk.id);
      if (chunk.offset !== offset || chunk.count !== expectedCount ||
        chunk.id !== `${kind}:${String(offset).padStart(8, "0")}` ||
        !previousChunkIds.has(chunk.id) || !previous ||
        previous.kind !== chunk.kind || previous.offset !== chunk.offset || previous.count !== chunk.count ||
        previous.checksum !== chunk.checksum || previous.bytes !== chunk.bytes) return null;
      offset += chunk.count;
    }
    return chunks.length > 0 && offset === total ? chunks : null;
  };
  const reusableEntities = reusableByKind("entities", projection.entityCount, CHUNKED_ENTITY_SIZE);
  const reusableBelts = reusableByKind("belts", projection.beltCount, CHUNKED_BELT_SIZE);
  if (reusableEntities && reusableBelts && reusableEntities.length + reusableBelts.length === reusableChunks.length) {
    // The Worker revision has not changed and the durable previous manifest
    // proves every collection page still exists. Reuse only metadata; no
    // entity/belt projection, JSON allocation, hashing, or IPC is required.
    metadata.push(...reusableEntities, ...reusableBelts);
  } else {
    await consumeRanges(projection.entityCount, "entities", CHUNKED_ENTITY_SIZE, projection.projectEntityRange);
    await consumeRanges(projection.beltCount, "belts", CHUNKED_BELT_SIZE, projection.projectBeltRange);
  }
  await flush();
  const manifest: ChunkedSaveManifest = {
    formatVersion: CHUNKED_SAVE_FORMAT_VERSION,
    envelopeFormatVersion: CHUNKED_SAVE_ENVELOPE_FORMAT_VERSION,
    mode: options.mode,
    slot: "main",
    stateVersion: projection.base.version,
    savedAt: options.savedAt ?? Date.now(),
    basePrimaryChecksum: options.basePrimaryChecksum,
    chunkRootChecksum: chunkRootChecksum(metadata),
    totalBytes: metadata.reduce((sum, chunk) => sum + chunk.bytes, 0),
    entityCount: projection.entityCount,
    beltCount: projection.beltCount,
    chunks: metadata,
  };
  const staleKeys = context.existingKeys.filter((key) =>
    key !== manifestKey(options.mode) && !manifest.chunks.some((chunk) => key === chunkKey(options.mode, chunk.id)));
  await writeBatch([
    ...staleKeys.map((key) => ({ key, value: null })),
    { key: manifestKey(options.mode), value: JSON.stringify(manifest) },
  ]);
  return {
    success: true,
    changedChunks: changedChunkIds.length,
    changedBytes,
    totalBytes: manifest.totalBytes,
    chunkCount: manifest.chunks.length,
    savedAt: manifest.savedAt,
    manifest,
  };
}

export async function clearChunkedSaveJournal(mode: SaveMode): Promise<void> {
  const keys = await listLocalSaveInternalKeys(journalPrefix(mode));
  if (keys.length > 0) await commitLocalSaveInternalRecords(keys.map((key) => ({ key, value: null })));
}

/**
 * Apply a newer sidecar only when it is based on the exact verified primary.
 * Any malformed/mismatched journal is ignored and the caller keeps the old
 * v47 payload, preserving backward compatibility with 1.1.7.
 */
export async function restoreChunkedSavePayload(baseRaw: string, mode: SaveMode): Promise<RestoredChunkedSave | null> {
  return restoreChunkedSavePayloadWithReader(baseRaw, mode, readLocalSaveInternalValue);
}

function manifestMatchesPrimary(
  manifest: ChunkedSaveManifest | null,
  mode: SaveMode,
  primary: ReturnType<typeof inspectSaveEnvelopeChecksum>,
): manifest is ChunkedSaveManifest {
  const savedAt = primary.parsed?.savedAt;
  // The state checksum deliberately excludes envelope time. An unchanged
  // state saved again must still supersede an older journal; otherwise a
  // recovery can rewind savedAt and make already-consumed time eligible again.
  return manifest !== null && manifest.mode === mode &&
    manifest.basePrimaryChecksum === primary.recordedChecksum &&
    typeof savedAt === "number" && Number.isSafeInteger(savedAt) && savedAt >= 0 &&
    manifest.savedAt >= savedAt;
}

/** Validate the primary and manifest before pulling any large native/IDB chunks. */
export async function restoreChunkedSavePayloadWithReader(
  baseRaw: string,
  mode: SaveMode,
  readRecord: (key: string) => Promise<string | null>,
): Promise<RestoredChunkedSave | null> {
  const integrity = inspectSaveEnvelopeChecksum(baseRaw);
  const baseChecksum = integrity.recordedChecksum;
  if (!baseChecksum || integrity.status === "invalid") return null;
  const manifest = parseManifest(await readRecord(manifestKey(mode)));
  if (!manifestMatchesPrimary(manifest, mode, integrity)) return null;
  const values = new Map<string, string>();
  for (const chunk of manifest.chunks) {
    const text = await readRecord(chunkKey(mode, chunk.id));
    if (text === null) return null;
    const identity = computeSavePayloadTextChecksum(text);
    if (identity.checksum !== chunk.checksum || identity.byteLength !== chunk.bytes) return null;
    values.set(chunk.id, text);
  }
  const state = assembleState(manifest, values);
  if (!state || state.version !== manifest.stateVersion || state.mode !== mode) return null;
  const raw = buildEnvelope(state, manifest);
  const rebuilt = inspectSaveEnvelopeChecksum(raw);
  if (rebuilt.status !== "valid") return null;
  return { raw, manifest };
}

/**
 * Rebuild a compatible envelope from an already verified internal-record
 * snapshot. Windows native recovery uses this exact adapter, so IndexedDB and
 * the Rust store cannot drift into two different v47 reconstruction rules.
 */
export function restoreChunkedSavePayloadFromRecords(
  baseRaw: string,
  mode: SaveMode,
  records: ReadonlyMap<string, string>,
): RestoredChunkedSave | null {
  const integrity = inspectSaveEnvelopeChecksum(baseRaw);
  const baseChecksum = integrity.recordedChecksum;
  if (!baseChecksum || integrity.status === "invalid") return null;
  const manifest = parseManifest(records.get(manifestKey(mode)) ?? null);
  if (!manifestMatchesPrimary(manifest, mode, integrity)) return null;
  const values = new Map<string, string>();
  for (const chunk of manifest.chunks) {
    const text = records.get(chunkKey(mode, chunk.id));
    if (text === undefined) return null;
    const identity = computeSavePayloadTextChecksum(text);
    if (identity.checksum !== chunk.checksum || identity.byteLength !== chunk.bytes) return null;
    values.set(chunk.id, text);
  }
  const state = assembleState(manifest, values);
  if (!state || state.version !== manifest.stateVersion || state.mode !== mode) return null;
  const raw = buildEnvelope(state, manifest);
  return inspectSaveEnvelopeChecksum(raw).status === "valid" ? { raw, manifest } : null;
}

/** Exposed for the benchmark and unit tests without touching IndexedDB. */
export function chunkedSavePartsForTest(projectedState: GameState, previous?: ChunkedSaveManifest | null): ChunkedSaveBuildResult {
  return buildChunkedSaveJournal(projectedState, { mode: projectedState.mode, basePrimaryChecksum: "00000000", previous });
}

/** Exposed only for byte-equivalence tests of the bounded projection path. */
export function chunkedRuntimeSavePartsForTest(
  state: GameState,
  contentPackRegistry: ContentPackRegistry,
): ChunkedSavePartsBuildResult {
  return buildChunkedSaveJournalParts(
    { stateVersion: state.version, entityCount: state.entities.length, beltCount: state.belts.length },
    { mode: state.mode, basePrimaryChecksum: "00000000" },
    (visit) => { visitRuntimeProjectionParts(state, contentPackRegistry, visit); },
  );
}
