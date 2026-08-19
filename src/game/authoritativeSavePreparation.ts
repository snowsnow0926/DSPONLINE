import type { ContentPackRegistry } from "./contentPacks";
import {
  canonicalAuthoritativeSaveJson,
  canonicalizeAuthoritativeSaveSettings,
  computeAuthoritativeSaveProofBindingSha256,
} from "./authoritativeSaveProof";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePayloadProof,
} from "./authoritativeSavePersistenceProtocol";
import type {
  AuthoritativeSaveCheckpointOverlay,
  AuthoritativeSaveSerializationSummary,
} from "./authoritativeSaveSerializationProtocol";
import { sha256Bytes } from "./payloadDigest";
import { projectPersistentSaveState } from "./saveProjection";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { GameState } from "./types";

const SETTINGS_MAX_BYTES = 2 * 1024;
const MIN_CANVAS_ZOOM = 0.25;
const MAX_CANVAS_ZOOM = 1.8;
const MAX_PENDING_TIME_WARP_SECONDS = 30 * 24 * 60 * 60;

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function catalogSettings(value: unknown): AuthoritativeSaveCatalogSeed["settings"] {
  try {
    const settings = canonicalizeAuthoritativeSaveSettings(value);
    return settings && new TextEncoder().encode(canonicalAuthoritativeSaveJson(settings)).byteLength <= SETTINGS_MAX_BYTES
      ? settings
      : null;
  } catch {
    return null;
  }
}

/**
 * Apply the only UI-owned leaves that may legitimately advance after the
 * simulation Worker established its authoritative state. This function is
 * shared by both save Workers so prepared payloads and the compatibility path
 * use one validation contract.
 */
export function applyAuthoritativeSaveCheckpointOverlay(
  state: GameState,
  overlay: AuthoritativeSaveCheckpointOverlay | undefined,
): GameState {
  if (!overlay) return state;
  let next = state;
  if (overlay.planetViewports !== undefined) {
    if (!Array.isArray(overlay.planetViewports) || overlay.planetViewports.length > Object.keys(state.planetViewports).length) {
      throw new Error("save checkpoint viewport overlay 不合法");
    }
    let planetViewports = state.planetViewports;
    const seenPlanetIds = new Set<string>();
    for (const entry of overlay.planetViewports) {
      const viewport = entry?.viewport;
      if (!entry || !viewport ||
        typeof entry.planetId !== "string" || !Object.hasOwn(state.planetViewports, entry.planetId) ||
        seenPlanetIds.has(entry.planetId) ||
        !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) ||
        !Number.isFinite(viewport.zoom) || viewport.zoom < MIN_CANVAS_ZOOM || viewport.zoom > MAX_CANVAS_ZOOM) {
        throw new Error("save checkpoint viewport overlay 不合法");
      }
      seenPlanetIds.add(entry.planetId);
      const previous = planetViewports[entry.planetId];
      if (previous?.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) continue;
      if (planetViewports === state.planetViewports) planetViewports = { ...state.planetViewports };
      planetViewports[entry.planetId] = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    }
    if (planetViewports !== state.planetViewports) next = { ...next, planetViewports };
  }
  if (overlay.timeWarp !== undefined && (
    !Number.isFinite(overlay.timeWarp.pendingSimulationSeconds) || !Number.isFinite(overlay.timeWarp.pendingWallSeconds) ||
    overlay.timeWarp.pendingSimulationSeconds < 0 || overlay.timeWarp.pendingWallSeconds < 0 ||
    overlay.timeWarp.pendingSimulationSeconds > MAX_PENDING_TIME_WARP_SECONDS ||
    overlay.timeWarp.pendingWallSeconds > MAX_PENDING_TIME_WARP_SECONDS
  )) {
    throw new Error("save checkpoint time warp overlay 不合法");
  }
  const pendingSimulationSeconds = overlay.timeWarp?.pendingSimulationSeconds;
  const pendingWallSeconds = overlay.timeWarp?.pendingWallSeconds;
  if (pendingSimulationSeconds !== undefined && pendingWallSeconds !== undefined &&
    (next.timeWarp.pendingSimulationSeconds !== pendingSimulationSeconds || next.timeWarp.pendingWallSeconds !== pendingWallSeconds)) {
    next = {
      ...next,
      timeWarp: {
        ...next.timeWarp,
        pendingSimulationSeconds,
        pendingWallSeconds,
      },
    };
  }
  return next;
}

export interface PreparedAuthoritativeSavePayload {
  bytes: ArrayBuffer;
  proof: AuthoritativeSavePayloadProof;
  catalogSeed: AuthoritativeSaveCatalogSeed;
  summary: AuthoritativeSaveSerializationSummary;
  durationMs: number;
}

export interface PrepareAuthoritativeSavePayloadOptions {
  formatVersion: number;
  savedAt: number;
  kind: "primary" | "slot" | "snapshot";
  slot: "main" | 1 | 2 | 3;
  reason?: string;
  contentPackRegistry: ContentPackRegistry;
  checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
}

/**
 * Build the canonical v2 envelope and its bound proof directly beside the
 * authoritative state. The persistence Worker still distrusts this proof: it
 * independently hashes, parses, binds, commits and reads back the exact bytes.
 */
export async function prepareAuthoritativeSavePayload(
  sourceState: GameState,
  options: PrepareAuthoritativeSavePayloadOptions,
): Promise<PreparedAuthoritativeSavePayload> {
  const startedAt = performance.now();
  const state = applyAuthoritativeSaveCheckpointOverlay(sourceState, options.checkpointOverlay);
  const persistent = projectPersistentSaveState(state, options.contentPackRegistry);
  const mode = persistent.mode === "speedrun" ? "speedrun" : "normal";
  const serialized = serializeSaveEnvelopeToTransfer(persistent, {
    formatVersion: options.formatVersion,
    kind: options.kind,
    ...(options.reason ? { reason: options.reason } : {}),
    mode,
    slot: options.slot,
    savedAt: options.savedAt,
  });
  const payloadSha256 = await sha256Bytes(serialized.bytes);
  const summary: AuthoritativeSaveSerializationSummary = {
    stateVersion: nonNegativeInteger(persistent.version),
    savedAt: options.savedAt,
    mode,
    kind: options.kind,
    slot: options.slot,
    reason: options.reason?.slice(0, 256) ?? null,
    elapsedSeconds: nonNegativeInteger(persistent.elapsedSeconds),
    activePlanetId: typeof persistent.activePlanetId === "string" ? persistent.activePlanetId : "home",
    entityCount: Array.isArray(persistent.entities) ? persistent.entities.length : 0,
    beltCount: Array.isArray(persistent.belts) ? persistent.belts.length : 0,
    completedTechCount: Array.isArray(persistent.research?.completedTechIds) ? persistent.research.completedTechIds.length : 0,
    structurePoints: nonNegativeInteger(persistent.dysonSphere?.structurePoints),
    uploadedWhiteMatrix: nonNegativeInteger(persistent.totalProduced?.universe_matrix),
    stateChecksum: serialized.stateChecksum,
    computedStateChecksum: serialized.stateChecksum,
    integrity: "valid",
  };
  const catalogSeed: AuthoritativeSaveCatalogSeed = {
    mode,
    kind: options.kind,
    slot: options.slot,
    savedAt: options.savedAt,
    stateVersion: summary.stateVersion,
    entityCount: summary.entityCount,
    beltCount: summary.beltCount,
    elapsedSeconds: summary.elapsedSeconds,
    completedTechCount: summary.completedTechCount,
    activePlanetId: summary.activePlanetId,
    structurePoints: summary.structurePoints,
    stateChecksum: serialized.stateChecksum,
    modeExplicit: true,
    reason: summary.reason,
    settings: catalogSettings(persistent.settings),
  };
  const proofWithoutBinding: Omit<AuthoritativeSavePayloadProof, "bindingSha256"> = {
    integrity: "valid",
    payloadChecksum: serialized.payloadChecksum,
    payloadSha256,
    byteLength: serialized.byteLength,
    stateChecksum: serialized.stateChecksum,
  };
  const proof: AuthoritativeSavePayloadProof = {
    ...proofWithoutBinding,
    bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, catalogSeed),
  };
  return {
    bytes: serialized.bytes,
    proof,
    catalogSeed,
    summary,
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}
