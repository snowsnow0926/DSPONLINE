import { getDesktopBridge } from "../desktop";
import { restoreChunkedSavePayloadWithReader, type RestoredChunkedSave } from "./chunkedSaveJournal";
import type { SaveMode } from "./types";
import { markWindowsNativeSaveSeeded } from "./nativeSave";

const MAX_NATIVE_RECORD_COUNT = 4_096;

export async function restoreWindowsNativeSavePayload(
  baseRaw: string,
  mode: SaveMode,
): Promise<RestoredChunkedSave | null> {
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  const status = await desktop.getNativePerformanceStatus().catch(() => null);
  if (!status?.available || status.nativeFormatVersion !== 1) return null;
  const slot = mode === "speedrun" ? "speedrun-main" : "normal-main";
  const recovery = await desktop.recoverNativeSave({ slot }).catch(() => null);
  if (!recovery || recovery.mode !== mode || recovery.stateVersion !== 47 || recovery.slot !== slot ||
    !Number.isSafeInteger(recovery.generation) || recovery.generation < 1 ||
    !/^[a-f0-9]{64}$/.test(recovery.rootHash) || !Array.isArray(recovery.recordKeys) ||
    recovery.recordKeys.length < 1 || recovery.recordKeys.length > MAX_NATIVE_RECORD_COUNT ||
    new Set(recovery.recordKeys).size !== recovery.recordKeys.length) return null;
  markWindowsNativeSaveSeeded(mode);
  for (const key of recovery.recordKeys) {
    if (typeof key !== "string" || key.length < 1 || key.length > 512 || key.includes("..") || /[\\/\0]/.test(key)) return null;
  }
  const keys = new Set(recovery.recordKeys);
  return restoreChunkedSavePayloadWithReader(baseRaw, mode, async (key) => {
    if (!keys.has(key)) return null;
    const read = await desktop.readNativeSave({
      slot,
      key,
      generation: recovery.generation,
      rootHash: recovery.rootHash,
    }).catch(() => null);
    if (!read || read.slot !== slot || read.key !== key || read.generation !== recovery.generation ||
      read.rootHash !== recovery.rootHash || typeof read.value !== "string") return null;
    return read.value;
  });
}
