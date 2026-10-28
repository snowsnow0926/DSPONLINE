import type { ContentPackRegistry } from "./contentPacks";
import { createPersistentSaveProjectionParts } from "./saveProjection";
import { serializeSaveStateJsonChunksToTransfer, type SaveTransferOptions, type SerializedSaveTransfer } from "./saveTransfer";
import type { GameState } from "./types";

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
  const projection = createPersistentSaveProjectionParts(state, registry);
  function* fragments(): Generator<string> {
    yield "{";
    let first = true;
    for (const key of projection.fieldOrder) {
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
