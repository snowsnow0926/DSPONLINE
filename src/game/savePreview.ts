import type { GameSettings, PlanetId, SaveMode } from "./types";
import {
  getLocalSaveCatalog,
  getPrimaryLocalSaveRevision,
  listLocalSaveKeys,
} from "./localSaveStore";
import type { LocalSaveCatalog } from "./localSaveCatalog";

const SAVE_KEY = "dsp-idle-network.save.v1";
const SAVE_BACKUP_KEY = `${SAVE_KEY}.backup`;
const SAVE_SLOT_KEY_PREFIX = "dsp-idle-network.slot";
const SAVE_SNAPSHOT_KEY_PREFIX = `${SAVE_KEY}.snapshot`;

export type MenuSaveSource = "primary" | "backup" | "snapshot";

export interface MenuSaveSummary {
  mode: SaveMode;
  savedAt: number;
  elapsedSeconds: number;
  completedTechCount: number;
  structurePoints: number;
  activePlanetId: PlanetId;
  entityCount: number;
  beltCount: number;
  stateVersion: number;
  stateChecksum: string | null;
}

export interface MenuContinueSave {
  key: string;
  source: MenuSaveSource;
  summary: MenuSaveSummary;
  settings: Partial<GameSettings> | null;
  localRevision: number;
  byteLength: number;
}

export interface MenuSlotSummary extends MenuSaveSummary {
  key: string;
  slotId: 1 | 2 | 3;
  valid: true;
}

export interface MenuSnapshotSummary extends MenuSaveSummary {
  key: string;
  id: string;
  reason: string;
  valid: true;
}

const PLANET_NAMES: Record<PlanetId, string> = {
  home: "澄海 I", ashen: "烬原 II", giant: "苍岚 III", frost: "霜原 I", boreal_giant: "青冥 II",
  magnetar: "极夜 I", verdant: "翠环 I", pelagic: "澜渊 II", aurora_giant: "天穹 III", dune: "赤砂 I",
  cinder: "灰烬 II", ember_giant: "红飓 III", crystal: "晶穹 I", prairie: "牧云 II", sirius_giant: "银冠 III",
  salt: "白盐 I", obsidian: "黑曜 II", white_giant: "苍白 III", tempest: "风暴 I", inferno: "炽核 II",
  abyss: "幽冥 III", azure_giant: "蓝穹 IV",
};

function isPlanetId(value: string): value is PlanetId {
  return value in PLANET_NAMES;
}

function snapshotKeys(mode: SaveMode = "normal"): string[] {
  const prefix = mode === "normal" ? SAVE_SNAPSHOT_KEY_PREFIX : `${SAVE_SNAPSHOT_KEY_PREFIX}.${mode}`;
  const sequenceKey = `${prefix}.sequence`;
  return listLocalSaveKeys()
    .filter((key) => mode === "speedrun"
      ? key.startsWith(`${prefix}.`) && key !== sequenceKey
      : key.startsWith(`${prefix}.`) && !key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.speedrun.`) && key !== sequenceKey)
    .sort((left, right) => right.localeCompare(left));
}

function summaryFromCatalog(catalog: LocalSaveCatalog): MenuSaveSummary {
  return {
    mode: catalog.mode,
    savedAt: catalog.savedAt,
    elapsedSeconds: catalog.elapsedSeconds,
    completedTechCount: catalog.completedTechCount,
    structurePoints: catalog.structurePoints,
    activePlanetId: isPlanetId(catalog.activePlanetId) ? catalog.activePlanetId : "home",
    entityCount: catalog.entityCount,
    beltCount: catalog.beltCount,
    stateVersion: catalog.stateVersion,
    stateChecksum: catalog.stateChecksum,
  };
}

function catalogForMode(key: string, mode: SaveMode): LocalSaveCatalog | null {
  const catalog = getLocalSaveCatalog(key);
  return catalog && catalog.mode === mode && catalog.integrity !== "invalid" ? catalog : null;
}

function continueCandidates(mode: SaveMode): Array<{ source: MenuSaveSource; key: string }> {
  return [
    { source: "primary", key: mode === "normal" ? SAVE_KEY : `${SAVE_KEY}.${mode}` },
    ...(mode === "speedrun" ? [{ source: "primary" as const, key: `${SAVE_KEY}.${mode}.emergency` }] : []),
    { source: "backup", key: mode === "normal" ? SAVE_BACKUP_KEY : `${SAVE_BACKUP_KEY}.${mode}` },
    ...snapshotKeys(mode).map((key) => ({ source: "snapshot" as const, key })),
  ];
}

function continueHandle(candidate: { source: MenuSaveSource; key: string }, mode: SaveMode): MenuContinueSave | null {
  const catalog = catalogForMode(candidate.key, mode);
  return catalog ? {
    key: candidate.key,
    source: candidate.source,
    summary: summaryFromCatalog(catalog),
    settings: catalog.settings,
    localRevision: getPrimaryLocalSaveRevision(mode),
    byteLength: catalog.byteLength,
  } : null;
}

export function getMenuContinueSave(mode: SaveMode = "normal"): MenuContinueSave | null {
  for (const candidate of continueCandidates(mode)) {
    const handle = continueHandle(candidate, mode);
    if (handle) return handle;
  }
  return null;
}

export function getMenuContinueSaveCandidates(mode: SaveMode = "normal"): MenuContinueSave[] {
  return continueCandidates(mode).flatMap((candidate) => {
    const handle = continueHandle(candidate, mode);
    return handle ? [handle] : [];
  });
}

export function getMenuSlotSummaries(mode: SaveMode = "normal"): MenuSlotSummary[] {
  return ([1, 2, 3] as const).flatMap((slotId) => {
    const key = mode === "normal" ? `${SAVE_SLOT_KEY_PREFIX}.${slotId}` : `${SAVE_SLOT_KEY_PREFIX}.${mode}.${slotId}`;
    const catalog = catalogForMode(key, mode);
    return catalog ? [{ key, slotId, ...summaryFromCatalog(catalog), valid: true as const }] : [];
  });
}

export function getMenuSnapshotSummaries(mode: SaveMode = "normal"): MenuSnapshotSummary[] {
  return snapshotKeys(mode).flatMap((key) => {
    const catalog = catalogForMode(key, mode);
    if (!catalog) return [];
    return [{
      key,
      id: key.includes(`${SAVE_SNAPSHOT_KEY_PREFIX}.${mode}.`) && mode !== "normal"
        ? key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.${mode}.`.length)
        : key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.`.length),
      ...summaryFromCatalog(catalog),
      reason: catalog.reason ?? "自动快照",
      valid: true as const,
    }];
  }).sort((left, right) => right.savedAt - left.savedAt);
}

export function getMenuPlanetName(planetId: PlanetId): string {
  return PLANET_NAMES[planetId];
}
