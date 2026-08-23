/// <reference lib="webworker" />

import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { hydrateCurrentPersistentSaveProjection, projectPersistentSaveState } from "./saveProjection";
import { deserializeSimulationStateTransfer, serializeSimulationStateForTransfer } from "./simulationRuntimeProtocol";
import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { sha256Bytes } from "./payloadDigest";
import { prepareSavePayloadTransport } from "./savePayloadCompression";
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
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
  AuthoritativeSaveSerializationSummary,
} from "./authoritativeSaveSerializationProtocol";
import type { SaveWorkerRequest, SaveWorkerResponse } from "./saveWorkerProtocol";
import type { GameState } from "./types";
import {
  createImmutableWorkerBinaryPayload,
  workerBinaryPayloadToArrayBuffer,
  workerBinaryPayloadTransferables,
  type WorkerBinaryPayload,
} from "./workerBinaryPayload";

const SETTINGS_MAX_BYTES = 2 * 1024;
const MIN_CANVAS_ZOOM = 0.25;
const MAX_CANVAS_ZOOM = 1.8;
const MAX_PENDING_TIME_WARP_SECONDS = 30 * 24 * 60 * 60;

type SaveSerializationRequest = SaveWorkerRequest | AuthoritativeSaveSerializationRequest;

function isAuthoritativeProofRequest(request: SaveSerializationRequest): request is AuthoritativeSaveSerializationRequest {
  return ("includeAuthoritativeProof" in request && request.includeAuthoritativeProof === true) ||
    "expectedStateIdentity" in request;
}

function integer(value: unknown): number {
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

function sourceTransferables(request: SaveSerializationRequest): Transferable[] {
  if (request.stateTransfer) return [request.stateTransfer.buffer];
  if ("envelopeTransfer" in request && request.envelopeTransfer) {
    return workerBinaryPayloadTransferables(request.envelopeTransfer.buffer);
  }
  return [];
}

async function deserializeAuthoritativeEnvelopeTransfer(
  source: Extract<AuthoritativeSaveSerializationRequest, { envelopeTransfer: unknown }>["envelopeTransfer"],
  contentPackRegistry: AuthoritativeSaveSerializationRequest["contentPackRegistry"],
): Promise<GameState> {
  const raw = decodeVerifiedSaveTransfer(await workerBinaryPayloadToArrayBuffer(source.buffer), source);
  const inspection = inspectSaveEnvelopeChecksum(raw);
  if (inspection.status !== "valid" || inspection.formatVersion !== 2 ||
    !inspection.parsed || !inspection.state ||
    inspection.recordedChecksum !== source.stateChecksum ||
    inspection.computedChecksum !== source.stateChecksum) {
    throw new Error("authoritative envelope transfer 完整性校验失败");
  }
  const state = hydrateCurrentPersistentSaveProjection(inspection.state);
  const envelopeMode = inspection.parsed.mode;
  if (!state || !Array.isArray(state.entities) || !Array.isArray(state.belts) ||
    (state.mode !== "normal" && state.mode !== "speedrun") ||
    envelopeMode !== state.mode ||
    inspection.parsed.kind !== "primary" || inspection.parsed.slot !== "main" ||
    !Number.isSafeInteger(inspection.parsed.savedAt) || (inspection.parsed.savedAt as number) < 0) {
    throw new Error("authoritative envelope transfer 状态身份无效");
  }
  return state;
}

function applyCheckpointOverlay(
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

self.onmessage = async (event: MessageEvent<SaveSerializationRequest>) => {
  const startedAt = performance.now();
  const request = event.data;
  const authoritativeProof = isAuthoritativeProofRequest(request);
  try {
    const envelopeTransfer = "envelopeTransfer" in request ? request.envelopeTransfer : undefined;
    const sourceCount = Number(request.state !== undefined) + Number(request.stateTransfer !== undefined) + Number(envelopeTransfer !== undefined);
    if (sourceCount !== 1) {
      throw new Error("后台存档必须且只能提供一个权威状态来源");
    }
    const sourceTransfer = request.stateTransfer;
    const sourceState = sourceTransfer
      ? deserializeSimulationStateTransfer(sourceTransfer)
      : envelopeTransfer
        ? await deserializeAuthoritativeEnvelopeTransfer(envelopeTransfer, request.contentPackRegistry)
        : request.state as GameState;
    const state = authoritativeProof
      ? applyCheckpointOverlay(sourceState, request.checkpointOverlay)
      : sourceState;
    // Envelope sources are converted to the runtime transfer used to rebase
    // the normal simulation Worker after the proof-bound primary commit. It is
    // serialized from the exact post-overlay state that produces the save
    // proof, so persistence and runtime authority cannot diverge.
    const returnedStateTransfer = envelopeTransfer
      ? serializeSimulationStateForTransfer(state)
      : sourceTransfer;
    const binaryTransport = envelopeTransfer?.buffer instanceof Blob ? "blob" : "array-buffer";
    const persistent = projectPersistentSaveState(state, request.contentPackRegistry);
    const mode = persistent.mode === "speedrun" ? "speedrun" : "normal";
    if (authoritativeProof) {
      const expected = request.expectedStateIdentity;
      if (expected && (
        expected.mode !== mode ||
        expected.version !== persistent.version ||
        expected.activePlanetId !== persistent.activePlanetId ||
        expected.entityCount !== persistent.entities.length ||
        expected.beltCount !== persistent.belts.length ||
        expected.elapsedSeconds !== persistent.elapsedSeconds
      )) {
        throw new Error("save Worker state transfer 与请求保存状态身份不一致");
      }
    }
    const serialized = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: request.formatVersion,
      kind: request.kind,
      ...(request.reason ? { reason: request.reason } : {}),
      mode,
      slot: request.slot,
      savedAt: request.savedAt,
    });
    const needsPayloadSha256 = request.includePayloadSha256 || authoritativeProof;
    const payloadSha256 = needsPayloadSha256 ? await sha256Bytes(serialized.bytes) : undefined;
    const summary: AuthoritativeSaveSerializationSummary = {
      stateVersion: integer(persistent.version),
      savedAt: request.savedAt,
      mode,
      kind: request.kind,
      slot: request.slot,
      reason: request.reason?.slice(0, 256) ?? null,
      elapsedSeconds: integer(persistent.elapsedSeconds),
      activePlanetId: typeof persistent.activePlanetId === "string" ? persistent.activePlanetId : "home",
      entityCount: Array.isArray(persistent.entities) ? persistent.entities.length : 0,
      beltCount: Array.isArray(persistent.belts) ? persistent.belts.length : 0,
      completedTechCount: Array.isArray(persistent.research?.completedTechIds) ? persistent.research.completedTechIds.length : 0,
      structurePoints: integer(persistent.dysonSphere?.structurePoints),
      uploadedWhiteMatrix: integer(persistent.totalProduced?.universe_matrix),
      stateChecksum: serialized.stateChecksum,
      computedStateChecksum: serialized.stateChecksum,
      integrity: "valid",
    };
    if (!authoritativeProof) {
      const response: SaveWorkerResponse = {
        id: request.id,
        bytes: serialized.bytes,
        payloadChecksum: serialized.payloadChecksum,
        ...(payloadSha256 ? { payloadSha256 } : {}),
        byteLength: serialized.byteLength,
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(Number.isSafeInteger(request.sourceStateRevision) ? { sourceStateRevision: request.sourceStateRevision } : {}),
        ...(returnedStateTransfer ? { sourceStateTransfer: returnedStateTransfer } : {}),
        summary,
      };
      self.postMessage(response, [serialized.bytes, ...sourceTransferables(request)]);
      return;
    }

    const catalogSeed: AuthoritativeSaveCatalogSeed = {
      mode,
      kind: request.kind,
      slot: request.slot,
      savedAt: request.savedAt,
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
    const transport = await prepareSavePayloadTransport(serialized.bytes, payloadSha256!);
    const proofWithoutBinding: Omit<AuthoritativeSavePayloadProof, "bindingSha256"> = {
      integrity: "valid",
      payloadChecksum: serialized.payloadChecksum,
      payloadSha256: payloadSha256!,
      byteLength: serialized.byteLength,
      stateChecksum: serialized.stateChecksum,
      transportEncoding: transport.encoding,
      storedByteLength: transport.storedByteLength,
      storedSha256: transport.storedSha256,
    };
    const proof: AuthoritativeSavePayloadProof = {
      ...proofWithoutBinding,
      bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, catalogSeed),
    };
    const responseBytes = createImmutableWorkerBinaryPayload(transport.buffer, binaryTransport);
    const responseStateTransfer: WorkerBinaryPayload | undefined = returnedStateTransfer
      ? createImmutableWorkerBinaryPayload(returnedStateTransfer.buffer, binaryTransport)
      : undefined;
    const response: AuthoritativeSaveSerializationResponse = {
      id: request.id,
      bytes: responseBytes,
      ...(responseStateTransfer ? { sourceStateTransfer: responseStateTransfer } : {}),
      ...(envelopeTransfer ? { sourceEnvelopeTransfer: envelopeTransfer.buffer } : {}),
      payloadChecksum: serialized.payloadChecksum,
      ...(payloadSha256 ? { payloadSha256 } : {}),
      byteLength: serialized.byteLength,
      durationMs: Math.max(0, performance.now() - startedAt),
      compressionDurationMs: transport.compressionDurationMs,
      summary,
      catalogSeed,
      proof,
    };
    const responseTransfers: Transferable[] = [
      ...workerBinaryPayloadTransferables(responseBytes),
      ...(responseStateTransfer && returnedStateTransfer !== sourceTransfer
        ? workerBinaryPayloadTransferables(responseStateTransfer)
        : []),
      ...sourceTransferables(request),
    ];
    self.postMessage(response, responseTransfers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "后台生成存档失败";
    if (authoritativeProof) {
      const response: AuthoritativeSaveSerializationResponse = {
        id: request.id,
        error: message,
        ...(request.stateTransfer ? { sourceStateTransfer: request.stateTransfer.buffer } : {}),
        ...("envelopeTransfer" in request && request.envelopeTransfer
          ? { sourceEnvelopeTransfer: request.envelopeTransfer.buffer }
          : {}),
      };
      self.postMessage(response, sourceTransferables(request));
      return;
    }
    const response: SaveWorkerResponse = {
      id: request.id,
      error: message,
      ...(request.stateTransfer ? { sourceStateTransfer: request.stateTransfer } : {}),
    };
    self.postMessage(response, sourceTransferables(request));
  }
};

export {};
