import type { CloudSaveMetadata, CloudSaveMode, CloudSaveSlot } from "../game/cloud";
import type { SaveInspection } from "../game/storage";

export const CLOUD_SAVE_MODE_OPTIONS: ReadonlyArray<{
  mode: CloudSaveMode;
  label: string;
  description: string;
}> = [
  { mode: "normal", label: "普通模式", description: "普通工厂" },
  { mode: "speedrun", label: "速通模式", description: "独立排行" },
];

export function cloudSaveModeLabel(mode: CloudSaveMode): string {
  return mode === "speedrun" ? "速通模式" : "普通模式";
}

export function cloudSaveSlotLabel(mode: CloudSaveMode, slot: CloudSaveSlot): string {
  return `${cloudSaveModeLabel(mode)} · ${slot === "main" ? "主存档" : `槽位 ${slot}`}`;
}

/**
 * Cloud routing is authoritative only after the downloaded envelope agrees
 * with both the selected mode and slot. Undefined metadata remains compatible
 * with older servers; an explicit conflicting value is never accepted.
 */
export function cloudRestoreTargetIssue(
  inspection: Pick<SaveInspection, "valid" | "mode" | "slot" | "issues">,
  metadata: Pick<CloudSaveMetadata, "mode" | "slot">,
  expectedMode: CloudSaveMode,
  expectedSlot: CloudSaveSlot,
): string | null {
  const target = cloudSaveSlotLabel(expectedMode, expectedSlot);
  if (!inspection.valid) return inspection.issues[0] ?? `${target}格式无效`;
  if (metadata.mode !== undefined && metadata.mode !== expectedMode) {
    return `云端元数据属于${cloudSaveModeLabel(metadata.mode)}，已阻止写入${target}`;
  }
  if (metadata.slot !== undefined && metadata.slot !== expectedSlot) {
    return `云端元数据属于${cloudSaveSlotLabel(expectedMode, metadata.slot)}，已阻止写入${target}`;
  }
  if (inspection.mode !== expectedMode) {
    return `下载正文属于${cloudSaveModeLabel(inspection.mode)}，已阻止写入${target}`;
  }
  const inspectedSlot = String(inspection.slot) as CloudSaveSlot;
  if (inspectedSlot !== expectedSlot) {
    return `下载正文属于${cloudSaveSlotLabel(expectedMode, inspectedSlot)}，已阻止写入${target}`;
  }
  return null;
}

/** Preserve the actual manual slot, including when its normalized export is unavailable. */
export async function preserveCloudRestoreSlot(
  mode: CloudSaveMode,
  slotId: 1 | 2 | 3,
  requireExisting = false,
): Promise<boolean> {
  const { getLocalSaveCatalog, readLocalSavePayload } = await import("../game/localSaveStore");
  const key = mode === "normal" ? `dsp-idle-network.slot.${slotId}` : `dsp-idle-network.slot.${mode}.${slotId}`;
  const raw = await readLocalSavePayload(key);
  // An unreadable/invalid catalog entry is still occupied. Never treat a
  // missing validated export as permission to overwrite its durable record.
  if (raw === null) return !requireExisting && getLocalSaveCatalog(key) === null;
  const { inspectSave, saveGameSnapshotVerified } = await import("../game/storage");
  const previous = inspectSave(raw);
  if (!previous.valid || !previous.state || previous.mode !== mode) return false;
  const declaredSlot = (JSON.parse(raw) as { slot?: unknown }).slot;
  if (declaredSlot !== undefined && previous.slot !== slotId) return false;
  // Older envelopes may omit slot. Preserve them without loading the factory
  // or advancing offline time; do not retain this state in the later write.
  return Boolean(await saveGameSnapshotVerified(previous.state, `恢复云端槽位 ${slotId} 前`));
}
