import { getLocalSaveCatalog } from "./localSaveStore";
import { getMenuContinueSaveCandidates, type MenuContinueSave } from "./savePreview";
import { readLocalSavePayloadWithChunkJournalSource } from "./storage";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import type { SaveInspection } from "./storage";
import type { SaveMode } from "./types";

async function inspectSelectedPayload(
  payload: { raw: string; primaryRaw: string }, mode: SaveMode, key: string,
): Promise<SaveInspection | null> {
  const { inspectSavePayloadInWorker } = await import("./saveInspection");
  const result = await inspectSavePayloadInWorker(payload.raw);
  const catalog = getLocalSaveCatalog(key);
  if (catalog && catalog.byteLength > 0) {
    const primaryIdentity = payload.raw === payload.primaryRaw
      ? { byteLength: result.byteLength, checksum: result.payloadChecksum }
      : computeSavePayloadTextChecksum(payload.primaryRaw);
    if (catalog.byteLength !== primaryIdentity.byteLength || catalog.payloadChecksum !== primaryIdentity.checksum) return null;
  }
  const inspection = result.inspection;
  return inspection.valid && inspection.state && inspection.mode === mode ? inspection : null;
}

/** Lazily read only the selected candidate, then fall back in the established order on corruption. */
export async function resolveMenuContinueSave(mode: SaveMode = "normal"): Promise<{ save: MenuContinueSave; raw: string; primaryRaw: string; inspection: SaveInspection } | null> {
  for (const handle of getMenuContinueSaveCandidates(mode)) {
    const payload = await readLocalSavePayloadWithChunkJournalSource(handle.key);
    if (!payload) continue;
    const inspection = await inspectSelectedPayload(payload, mode, handle.key);
    if (inspection) return { save: handle, ...payload, inspection };
  }
  return null;
}

export async function readMenuSavePayload(key: string): Promise<string | null> {
  const payload = await readLocalSavePayloadWithChunkJournalSource(key);
  if (!payload) return null;
  const catalog = getLocalSaveCatalog(key);
  const mode = catalog?.mode ?? (key.includes("speedrun") ? "speedrun" : "normal");
  return await inspectSelectedPayload(payload, mode, key) ? payload.raw : null;
}

export async function resolveMenuSavePayload(key: string, mode: SaveMode): Promise<{ raw: string; inspection: SaveInspection } | null> {
  const payload = await readLocalSavePayloadWithChunkJournalSource(key);
  if (!payload) return null;
  const inspection = await inspectSelectedPayload(payload, mode, key);
  return inspection ? { raw: payload.raw, inspection } : null;
}
