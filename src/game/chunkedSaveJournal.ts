import {
  commitLocalSaveInternalRecords,
  listLocalSaveInternalKeys,
  LOCAL_SAVE_INTERNAL_PREFIX,
  readLocalSaveInternalValue,
  type LocalSaveInternalWrite,
} from "./localSaveStore";
import { computeSaveStateChecksum, inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
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

export interface RestoredChunkedSave {
  raw: string;
  manifest: ChunkedSaveManifest;
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

export function buildChunkedSaveJournal(
  projectedState: GameState,
  options: { mode: SaveMode; basePrimaryChecksum: string; savedAt?: number; previous?: ChunkedSaveManifest | null; previousChunkTexts?: ReadonlyMap<string, string>; previousChunkIds?: ReadonlySet<string>; retainAllChunks?: boolean },
): ChunkedSaveBuildResult {
  const metadata: ChunkedSaveChunkMetadata[] = [];
  const chunks = new Map<string, string>();
  const previous = options.previous ?? null;
  const previousById = new Map(previous?.chunks.map((chunk) => [chunk.id, chunk]) ?? []);
  const changedChunkIds: string[] = [];
  const changedChunkSet = new Set<string>();
  let changedBytes = 0;
  visitProjectedParts(projectedState, (part) => {
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
    stateVersion: projectedState.version,
    savedAt: options.savedAt ?? Date.now(),
    basePrimaryChecksum: options.basePrimaryChecksum,
    chunkRootChecksum: chunkRootChecksum(metadata),
    totalBytes: metadata.reduce((sum, chunk) => sum + chunk.bytes, 0),
    entityCount: projectedState.entities.length,
    beltCount: projectedState.belts.length,
    chunks: metadata,
  };
  return { manifest, chunks, changedChunkIds, changedBytes, totalBytes: manifest.totalBytes, projectedState };
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

export async function persistChunkedSaveJournal(
  projectedState: GameState,
  options: PersistChunkedSaveOptions,
): Promise<PersistChunkedSaveResult> {
  const previous = parseManifest(await readLocalSaveInternalValue(manifestKey(options.mode)));
  const existingKeys = new Set(await listLocalSaveInternalKeys(journalPrefix(options.mode)));
  const previousChunkIds = new Set(
    previous?.basePrimaryChecksum === options.basePrimaryChecksum
      ? previous.chunks.filter((chunk) => existingKeys.has(chunkKey(options.mode, chunk.id))).map((chunk) => chunk.id)
      : [],
  );
  const build = buildChunkedSaveJournal(projectedState, {
    mode: options.mode,
    basePrimaryChecksum: options.basePrimaryChecksum,
    savedAt: options.savedAt,
    previous: previous?.basePrimaryChecksum === options.basePrimaryChecksum ? previous : null,
    previousChunkIds,
    retainAllChunks: false,
  });
  const staleKeys = (await listLocalSaveInternalKeys(journalPrefix(options.mode))).filter((key) =>
    key !== manifestKey(options.mode) && !build.manifest.chunks.some((chunk) => key === chunkKey(options.mode, chunk.id)));
  const writes: LocalSaveInternalWrite[] = [];
  for (const id of build.changedChunkIds) writes.push({ key: chunkKey(options.mode, id), value: build.chunks.get(id)! });
  for (const key of staleKeys) writes.push({ key, value: null });
  // Manifest is intentionally last in the transaction.
  writes.push({ key: manifestKey(options.mode), value: JSON.stringify(build.manifest) });
  await commitLocalSaveInternalRecords(writes);
  return {
    success: true,
    changedChunks: build.changedChunkIds.length,
    changedBytes: build.changedBytes,
    totalBytes: build.totalBytes,
    chunkCount: build.manifest.chunks.length,
    savedAt: build.manifest.savedAt,
    manifest: build.manifest,
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
  const integrity = inspectSaveEnvelopeChecksum(baseRaw);
  const baseChecksum = integrity.recordedChecksum;
  if (!baseChecksum || integrity.status === "invalid") return null;
  const manifest = parseManifest(await readLocalSaveInternalValue(manifestKey(mode)));
  if (!manifest || manifest.mode !== mode || manifest.basePrimaryChecksum !== baseChecksum) return null;
  const values = new Map<string, string>();
  for (const chunk of manifest.chunks) {
    const text = await readLocalSaveInternalValue(chunkKey(mode, chunk.id));
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

/** Exposed for the benchmark and unit tests without touching IndexedDB. */
export function chunkedSavePartsForTest(projectedState: GameState, previous?: ChunkedSaveManifest | null): ChunkedSaveBuildResult {
  return buildChunkedSaveJournal(projectedState, { mode: projectedState.mode, basePrimaryChecksum: "00000000", previous });
}
