import type { SaveEnvelopeChecksumStatus } from "./saveEnvelopeIntegrity";
import type { GameSettings, SaveMode } from "./types";

export const LOCAL_SAVE_CATALOG_SCHEMA_VERSION = 1;
export const LOCAL_SAVE_CATALOG_RECORD_PREFIX = "dsp-idle-network.local-save.catalog.v1.";
export const LOCAL_SAVE_CATALOG_MAX_BYTES = 4 * 1024;

export type LocalSaveCatalogKind = "primary" | "backup" | "slot" | "snapshot" | "protected" | "import-cache";

export interface LocalSaveCatalog {
  schemaVersion: 1;
  key: string;
  mode: SaveMode;
  kind: LocalSaveCatalogKind;
  slot: "main" | 1 | 2 | 3 | null;
  savedAt: number;
  byteLength: number;
  payloadChecksum: string;
  revision: number;
  stateVersion: number;
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
  completedTechCount: number;
  activePlanetId: string;
  structurePoints: number;
  integrity: SaveEnvelopeChecksumStatus;
  stateChecksum: string | null;
  reason: string | null;
  settings: Partial<GameSettings> | null;
}

export function localSaveCatalogRecordKey(key: string): string {
  return `${LOCAL_SAVE_CATALOG_RECORD_PREFIX}${encodeURIComponent(key)}`;
}

export function payloadKeyFromLocalSaveCatalogRecord(key: string): string | null {
  if (!key.startsWith(LOCAL_SAVE_CATALOG_RECORD_PREFIX)) return null;
  try {
    return decodeURIComponent(key.slice(LOCAL_SAVE_CATALOG_RECORD_PREFIX.length));
  } catch {
    return null;
  }
}

export function serializeLocalSaveCatalog(catalog: LocalSaveCatalog): string {
  let value = JSON.stringify(catalog);
  if (new TextEncoder().encode(value).byteLength >= LOCAL_SAVE_CATALOG_MAX_BYTES && catalog.settings !== null) {
    value = JSON.stringify({ ...catalog, settings: null });
  }
  if (new TextEncoder().encode(value).byteLength >= LOCAL_SAVE_CATALOG_MAX_BYTES) {
    value = JSON.stringify({ ...catalog, reason: catalog.reason?.slice(0, 32) ?? null, settings: null });
  }
  if (new TextEncoder().encode(value).byteLength >= LOCAL_SAVE_CATALOG_MAX_BYTES) throw new Error("Local save catalog must stay below 4 KiB");
  return value;
}

export function parseLocalSaveCatalog(value: string | null | undefined, expectedKey?: string): LocalSaveCatalog | null {
  if (!value) return null;
  try {
    if (new TextEncoder().encode(value).byteLength >= LOCAL_SAVE_CATALOG_MAX_BYTES) return null;
    const candidate = JSON.parse(value) as Partial<LocalSaveCatalog>;
    if (candidate.schemaVersion !== LOCAL_SAVE_CATALOG_SCHEMA_VERSION || typeof candidate.key !== "string" ||
      expectedKey !== undefined && candidate.key !== expectedKey ||
      (candidate.mode !== "normal" && candidate.mode !== "speedrun") ||
      !["primary", "backup", "slot", "snapshot", "protected", "import-cache"].includes(candidate.kind ?? "") ||
      !(candidate.slot === null || candidate.slot === "main" || candidate.slot === 1 || candidate.slot === 2 || candidate.slot === 3) ||
      !["valid", "missing", "invalid"].includes(candidate.integrity ?? "") ||
      typeof candidate.payloadChecksum !== "string" || !/^[0-9a-f]{8}$/.test(candidate.payloadChecksum) ||
      typeof candidate.activePlanetId !== "string" || candidate.activePlanetId.length > 128 ||
      !(candidate.reason === null || typeof candidate.reason === "string" && candidate.reason.length <= 256) ||
      !(candidate.settings === null || Boolean(candidate.settings) && typeof candidate.settings === "object" && !Array.isArray(candidate.settings)) ||
      !(candidate.stateChecksum === null || typeof candidate.stateChecksum === "string" && candidate.stateChecksum.length <= 256)) return null;
    for (const numberKey of ["savedAt", "byteLength", "revision", "stateVersion", "entityCount", "beltCount", "elapsedSeconds", "completedTechCount", "structurePoints"] as const) {
      const numberValue = candidate[numberKey];
      if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue) || numberValue < 0) return null;
    }
    return candidate as LocalSaveCatalog;
  } catch {
    return null;
  }
}
