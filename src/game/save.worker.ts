/// <reference lib="webworker" />

import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { projectPersistentSaveState } from "./saveProjection";
import { deserializeSimulationStateTransfer } from "./simulationRuntimeProtocol";
import { sha256Bytes } from "./payloadDigest";
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
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
  AuthoritativeSaveSerializationSummary,
} from "./authoritativeSaveSerializationProtocol";

const SETTINGS_MAX_BYTES = 2 * 1024;

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

self.onmessage = async (event: MessageEvent<AuthoritativeSaveSerializationRequest>) => {
  const startedAt = performance.now();
  try {
    const request = event.data;
    const sourceStateTransfer = request.stateTransfer?.buffer;
    const state = request.stateTransfer
      ? deserializeSimulationStateTransfer(request.stateTransfer)
      : request.state!;
    const persistent = projectPersistentSaveState(state, request.contentPackRegistry);
    const mode = persistent.mode === "speedrun" ? "speedrun" : "normal";
    const serialized = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: request.formatVersion,
      kind: request.kind,
      ...(request.reason ? { reason: request.reason } : {}),
      mode,
      slot: request.slot,
      savedAt: request.savedAt,
    });
    const needsPayloadSha256 = request.includePayloadSha256 || request.includeAuthoritativeProof;
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
    let catalogSeed: AuthoritativeSaveCatalogSeed | undefined;
    let proof: AuthoritativeSavePayloadProof | undefined;
    if (request.includeAuthoritativeProof) {
      catalogSeed = {
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
        reason: summary.reason,
        settings: catalogSettings(persistent.settings),
      };
      const proofWithoutBinding: Omit<AuthoritativeSavePayloadProof, "bindingSha256"> = {
        integrity: "valid",
        payloadChecksum: serialized.payloadChecksum,
        payloadSha256: payloadSha256!,
        byteLength: serialized.byteLength,
        stateChecksum: serialized.stateChecksum,
      };
      proof = {
        ...proofWithoutBinding,
        bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, catalogSeed),
      };
    }
    const response: AuthoritativeSaveSerializationResponse = {
      id: request.id,
      bytes: serialized.bytes,
      ...(sourceStateTransfer ? { sourceStateTransfer } : {}),
      payloadChecksum: serialized.payloadChecksum,
      ...(payloadSha256 ? { payloadSha256 } : {}),
      byteLength: serialized.byteLength,
      durationMs: Math.max(0, performance.now() - startedAt),
      summary,
      ...(catalogSeed ? { catalogSeed } : {}),
      ...(proof ? { proof } : {}),
    };
    self.postMessage(response, [serialized.bytes, ...(sourceStateTransfer ? [sourceStateTransfer] : [])]);
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : "后台生成存档失败",
      ...(event.data.stateTransfer ? { sourceStateTransfer: event.data.stateTransfer.buffer } : {}),
    } satisfies AuthoritativeSaveSerializationResponse, event.data.stateTransfer ? [event.data.stateTransfer.buffer] : []);
  }
};

export {};
