import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import {
  LOCAL_SAVE_CATALOG_SCHEMA_VERSION,
  type LocalSaveCatalog,
  type LocalSaveCatalogKind,
} from "./localSaveCatalog";
import type { GameSettings, SaveMode } from "./types";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function modeFromKey(key: string): SaveMode {
  return key.includes(".speedrun") || key.includes("slot.speedrun.") ? "speedrun" : "normal";
}

function slotFromKey(key: string): "main" | 1 | 2 | 3 | null {
  if (key === "dsp-idle-network.save.v1" || key === "dsp-idle-network.save.v1.normal" || key === "dsp-idle-network.save.v1.speedrun") return "main";
  const match = /^dsp-idle-network\.slot\.(?:speedrun\.)?([123])$/.exec(key);
  return match ? Number(match[1]) as 1 | 2 | 3 : null;
}

function kindFromKey(key: string): LocalSaveCatalogKind {
  if (key.includes(".import-cache.")) return "import-cache";
  if (key.includes(".migration-backup.") || key.includes(".conflict.")) return "protected";
  if (key === "dsp-idle-network.save.v1.backup" || key === "dsp-idle-network.save.v1.backup.speedrun") return "backup";
  if (key.startsWith("dsp-idle-network.slot.")) return "slot";
  return key.includes(".snapshot.") ? "snapshot" : "primary";
}

export function buildLocalSaveCatalog(key: string, payload: string, revision: number): LocalSaveCatalog {
  const inspection = inspectSaveEnvelopeChecksum(payload);
  const parsed = inspection.parsed;
  const state = inspection.state;
  const stateMode = state?.mode === "normal" || state?.mode === "speedrun" ? state.mode : null;
  const envelopeMode = parsed?.mode === "normal" || parsed?.mode === "speedrun" ? parsed.mode : null;
  const mode = stateMode ?? envelopeMode ?? modeFromKey(key);
  const research = record(state?.research) ? state.research : null;
  const sphere = record(state?.dysonSphere) ? state.dysonSphere : null;
  const transfer = computeSavePayloadTextChecksum(payload);
  let settings = record(state?.settings) ? state.settings as Partial<GameSettings> : null;
  try { if (settings && JSON.stringify(settings).length > 2_048) settings = null; } catch { settings = null; }
  return {
    schemaVersion: LOCAL_SAVE_CATALOG_SCHEMA_VERSION,
    key,
    mode,
    kind: kindFromKey(key),
    slot: parsed?.slot === "main" || parsed?.slot === 1 || parsed?.slot === 2 || parsed?.slot === 3 ? parsed.slot : slotFromKey(key),
    savedAt: integer(parsed?.savedAt),
    byteLength: transfer.byteLength,
    payloadChecksum: transfer.checksum,
    revision: integer(revision),
    stateVersion: integer(state?.version),
    entityCount: Array.isArray(state?.entities) ? state.entities.length : 0,
    beltCount: Array.isArray(state?.belts) ? state.belts.length : 0,
    elapsedSeconds: integer(state?.elapsedSeconds),
    completedTechCount: Array.isArray(research?.completedTechIds) ? research.completedTechIds.length : 0,
    activePlanetId: typeof state?.activePlanetId === "string" ? state.activePlanetId : "home",
    structurePoints: integer(sphere?.structurePoints),
    integrity: inspection.status,
    stateChecksum: inspection.recordedChecksum,
    reason: typeof parsed?.reason === "string" && parsed.reason ? parsed.reason.slice(0, 256) : null,
    settings,
  };
}

export function catalogMatchesPayload(catalog: LocalSaveCatalog, payload: string): boolean {
  const measured = computeSavePayloadTextChecksum(payload);
  return measured.byteLength === catalog.byteLength && measured.checksum === catalog.payloadChecksum;
}
