import { getLocalSaveCatalog, readLocalSavePayload } from "./localSaveStore";
import { getMenuContinueSaveCandidates, type MenuContinueSave } from "./savePreview";
import type { SaveInspection } from "./storage";
import type { SaveMode } from "./types";

async function inspectSelectedPayload(raw: string, mode: SaveMode, key: string): Promise<SaveInspection | null> {
  const { inspectSavePayloadInWorker } = await import("./saveInspection");
  const result = await inspectSavePayloadInWorker(raw);
  const catalog = getLocalSaveCatalog(key);
  if (catalog && catalog.byteLength > 0 &&
    (catalog.byteLength !== result.byteLength || catalog.payloadChecksum !== result.payloadChecksum)) return null;
  const inspection = result.inspection;
  return inspection.valid && inspection.state && inspection.mode === mode ? inspection : null;
}

/** Lazily read only the selected candidate, then fall back in the established order on corruption. */
export async function resolveMenuContinueSave(mode: SaveMode = "normal"): Promise<{ save: MenuContinueSave; raw: string; inspection: SaveInspection } | null> {
  for (const handle of getMenuContinueSaveCandidates(mode)) {
    const raw = await readLocalSavePayload(handle.key);
    if (!raw) continue;
    const inspection = await inspectSelectedPayload(raw, mode, handle.key);
    if (inspection) return { save: handle, raw, inspection };
  }
  return null;
}

export async function readMenuSavePayload(key: string): Promise<string | null> {
  const raw = await readLocalSavePayload(key);
  if (!raw) return null;
  const catalog = getLocalSaveCatalog(key);
  const mode = catalog?.mode ?? (key.includes("speedrun") ? "speedrun" : "normal");
  return await inspectSelectedPayload(raw, mode, key) ? raw : null;
}

export async function resolveMenuSavePayload(key: string, mode: SaveMode): Promise<{ raw: string; inspection: SaveInspection } | null> {
  const raw = await readLocalSavePayload(key);
  if (!raw) return null;
  const inspection = await inspectSelectedPayload(raw, mode, key);
  return inspection ? { raw, inspection } : null;
}
