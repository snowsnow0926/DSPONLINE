import type { ContentPackRegistry } from "./contentPacks";
import { createPersistentSaveProjectionParts, projectPersistentSaveState } from "./saveProjection";
import { computeSavePayloadChecksum, decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer,
  type SaveTransferOptions, type SerializedSaveTransfer } from "./saveTransfer";
import type { GameState } from "./types";

/** Macro-Worker-only framing. Keep the shared/ordinary serializer unchanged.
 * Use its tiny empty-state envelope as the header oracle, then replace only
 * the state and its checksum; persistence still verifies every final byte. */
export function serializeSaveStateJsonChunksToTransfer(source: Iterable<string>, options: SaveTransferOptions): SerializedSaveTransfer {
  const empty = serializeSaveEnvelopeToTransfer({}, options);
  const emptyRaw = decodeVerifiedSaveTransfer(empty.bytes, empty);
  const oldSuffix = `,"checksum":${JSON.stringify(empty.stateChecksum)}}`;
  if (!emptyRaw.endsWith(`{}${oldSuffix}`)) throw new Error("存档分批封装与标准格式不匹配");
  const prefix = emptyRaw.slice(0, -oldSuffix.length - 2);
  const chunks: string[] = [];
  let pending = "";
  for (const fragment of source) {
    let chunk = pending + fragment;
    pending = "";
    const last = chunk.charCodeAt(chunk.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      pending = chunk.slice(-1); chunk = chunk.slice(0, -1);
    }
    if (chunk.length) chunks.push(chunk);
  }
  if (pending) chunks.push(pending);
  if (!chunks.length) throw new Error("存档状态无法序列化");
  let hash = 0x811c9dc5;
  const statePrefix = `{"formatVersion":${JSON.stringify(options.formatVersion)},"state":`;
  for (let index = 0; index < statePrefix.length; index++) hash = Math.imul(hash ^ statePrefix.charCodeAt(index), 0x01000193);
  let stateBytes = 0;
  let previousHighSurrogate = false;
  for (const chunk of chunks) for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index);
    hash = Math.imul(hash ^ code, 0x01000193);
    if (code <= 0x7f) stateBytes++;
    else if (code <= 0x7ff) stateBytes += 2;
    else stateBytes += previousHighSurrogate && code >= 0xdc00 && code <= 0xdfff ? 1 : 3;
    previousHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  }
  const stateChecksum = (Math.imul(hash ^ 0x7d, 0x01000193) >>> 0).toString(16).padStart(8, "0");
  const encoder = new TextEncoder();
  const prefixBytes = encoder.encode(prefix);
  const suffix = encoder.encode(`,"checksum":${JSON.stringify(stateChecksum)}}`);
  const byteLength = prefixBytes.byteLength + stateBytes + suffix.byteLength;
  const bytes = new ArrayBuffer(byteLength);
  const view = new Uint8Array(bytes);
  view.set(prefixBytes);
  let offset = prefixBytes.byteLength;
  for (const chunk of chunks) {
    const written = encoder.encodeInto(chunk, view.subarray(offset));
    if (written.read !== chunk.length) throw new Error("存档 UTF-8 编码空间不足");
    offset += written.written;
  }
  view.set(suffix, offset); offset += suffix.byteLength;
  if (offset !== byteLength) throw new Error("存档 UTF-8 长度自检失败");
  return { bytes, byteLength, stateChecksum, payloadChecksum: computeSavePayloadChecksum(bytes), integrity: "valid" };
}

/** Read-only projection: only one bounded entity/belt page is materialized.
 * Preserve the complete JSON property/record order and all v2 proofs; the
 * canonical decoder and independent persistence verification still run. */
export function serializePersistentSaveEnvelopeToTransfer(
  state: GameState,
  registry: ContentPackRegistry,
  options: SaveTransferOptions,
  pageSize = 512,
): SerializedSaveTransfer {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 4_096) throw new Error("存档投影批大小无效");
  if (!Object.hasOwn(state, "entities") || !Object.hasOwn(state, "belts")) {
    return serializeSaveEnvelopeToTransfer(projectPersistentSaveState(state, registry), options);
  }
  const projection = createPersistentSaveProjectionParts(state, registry);
  // Projection keeps existing keys in source order and appends new base keys.
  // Filter bridge-only removals; the two own collection positions stay put.
  const baseFields = new Set(Object.keys(projection.base));
  const fieldOrder = [...new Set([...Object.keys(state), ...baseFields])]
    .filter((key) => key === "entities" || key === "belts" || baseFields.has(key));
  function* fragments(): Generator<string> {
    yield "{";
    let first = true;
    for (const key of fieldOrder) {
      const collection = key === "entities" || key === "belts";
      const encoded = collection ? undefined : JSON.stringify(projection.base[key as keyof typeof projection.base]);
      if (!collection && encoded === undefined) continue;
      yield `${first ? "" : ","}${JSON.stringify(key)}:`;
      first = false;
      if (!collection) { yield encoded!; continue; }
      yield "[";
      const total = key === "entities" ? projection.entityCount : projection.beltCount;
      for (let offset = 0; offset < total; offset += pageSize) {
        const page = key === "entities"
          ? projection.projectEntityRange(offset, pageSize) : projection.projectBeltRange(offset, pageSize);
        const text = JSON.stringify(page);
        yield `${offset ? "," : ""}${text.slice(1, -1)}`;
      }
      yield "]";
    }
    yield "}";
  }
  return serializeSaveStateJsonChunksToTransfer(fragments(), options);
}
