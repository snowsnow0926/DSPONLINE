/// <reference lib="webworker" />

import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { projectPersistentSaveState } from "./saveProjection";
import { deserializeSimulationStateTransfer, serializeSimulationStateForTransfer } from "./simulationRuntimeProtocol";
import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { sha256Bytes } from "./payloadDigest";
import { applyAuthoritativeSaveCheckpointOverlay, prepareAuthoritativeSavePayload } from "./authoritativeSavePreparation";
import type {
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
} from "./authoritativeSaveSerializationProtocol";
import type { SaveWorkerRequest, SaveWorkerResponse } from "./saveWorkerProtocol";
import type { GameState } from "./types";
import {
  createImmutableWorkerBinaryPayload,
  workerBinaryPayloadToArrayBuffer,
  workerBinaryPayloadTransferables,
  type WorkerBinaryPayload,
} from "./workerBinaryPayload";

type SaveSerializationRequest = SaveWorkerRequest | AuthoritativeSaveSerializationRequest;

function isAuthoritativeProofRequest(request: SaveSerializationRequest): request is AuthoritativeSaveSerializationRequest {
  return ("includeAuthoritativeProof" in request && request.includeAuthoritativeProof === true) ||
    "expectedStateIdentity" in request;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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
): Promise<GameState> {
  const raw = decodeVerifiedSaveTransfer(await workerBinaryPayloadToArrayBuffer(source.buffer), source);
  const inspection = inspectSaveEnvelopeChecksum(raw);
  if (inspection.status !== "valid" || inspection.formatVersion !== 2 ||
    !inspection.parsed || !inspection.state ||
    inspection.recordedChecksum !== source.stateChecksum ||
    inspection.computedChecksum !== source.stateChecksum) {
    throw new Error("authoritative envelope transfer 完整性校验失败");
  }
  const state = inspection.state as Partial<GameState>;
  const envelopeMode = inspection.parsed.mode;
  if (!Array.isArray(state.entities) || !Array.isArray(state.belts) ||
    (state.mode !== "normal" && state.mode !== "speedrun") ||
    envelopeMode !== state.mode ||
    inspection.parsed.kind !== "primary" || inspection.parsed.slot !== "main" ||
    !Number.isSafeInteger(inspection.parsed.savedAt) || (inspection.parsed.savedAt as number) < 0) {
    throw new Error("authoritative envelope transfer 状态身份无效");
  }
  return state as GameState;
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
        ? await deserializeAuthoritativeEnvelopeTransfer(envelopeTransfer)
        : request.state as GameState;
    const state = authoritativeProof
      ? applyAuthoritativeSaveCheckpointOverlay(sourceState, request.checkpointOverlay)
      : sourceState;
    // Envelope sources are converted to the runtime transfer used to rebase
    // the normal simulation Worker after the proof-bound primary commit. It is
    // serialized from the exact post-overlay state that produces the save
    // proof, so persistence and runtime authority cannot diverge.
    const returnedStateTransfer = envelopeTransfer
      ? serializeSimulationStateForTransfer(state)
      : sourceTransfer;
    const binaryTransport = envelopeTransfer?.buffer instanceof Blob ? "blob" : "array-buffer";
    if (authoritativeProof) {
      const expected = request.expectedStateIdentity;
      if (expected && (
        expected.mode !== state.mode ||
        expected.version !== state.version ||
        expected.activePlanetId !== state.activePlanetId ||
        expected.entityCount !== state.entities.length ||
        expected.beltCount !== state.belts.length ||
        expected.elapsedSeconds !== state.elapsedSeconds
      )) {
        throw new Error("save Worker state transfer 与请求保存状态身份不一致");
      }
      const prepared = await prepareAuthoritativeSavePayload(sourceState, {
        formatVersion: request.formatVersion,
        savedAt: request.savedAt,
        kind: request.kind,
        slot: request.slot,
        ...(request.reason ? { reason: request.reason } : {}),
        contentPackRegistry: request.contentPackRegistry,
        ...(request.checkpointOverlay ? { checkpointOverlay: request.checkpointOverlay } : {}),
      });
      const responseBytes = createImmutableWorkerBinaryPayload(prepared.bytes, binaryTransport);
      const responseStateTransfer: WorkerBinaryPayload | undefined = returnedStateTransfer
        ? createImmutableWorkerBinaryPayload(returnedStateTransfer.buffer, binaryTransport)
        : undefined;
      const response: AuthoritativeSaveSerializationResponse = {
        id: request.id,
        bytes: responseBytes,
        ...(responseStateTransfer ? { sourceStateTransfer: responseStateTransfer } : {}),
        ...(envelopeTransfer ? { sourceEnvelopeTransfer: envelopeTransfer.buffer } : {}),
        payloadChecksum: prepared.proof.payloadChecksum,
        payloadSha256: prepared.proof.payloadSha256,
        byteLength: prepared.proof.byteLength,
        durationMs: Math.max(0, performance.now() - startedAt),
        summary: prepared.summary,
        catalogSeed: prepared.catalogSeed,
        proof: prepared.proof,
      };
      const responseTransfers: Transferable[] = [
        ...workerBinaryPayloadTransferables(responseBytes),
        ...(responseStateTransfer && returnedStateTransfer !== sourceTransfer
          ? workerBinaryPayloadTransferables(responseStateTransfer)
          : []),
        ...sourceTransferables(request),
      ];
      self.postMessage(response, responseTransfers);
      return;
    }

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
    const payloadSha256 = request.includePayloadSha256 ? await sha256Bytes(serialized.bytes) : undefined;
    const summary = {
      stateVersion: integer(persistent.version),
      savedAt: request.savedAt,
      mode,
      kind: request.kind,
      slot: request.slot,
      reason: request.reason?.slice(0, 256) ?? null,
      elapsedSeconds: integer(persistent.elapsedSeconds),
      activePlanetId: typeof persistent.activePlanetId === "string" ? persistent.activePlanetId : "home",
      entityCount: persistent.entities.length,
      beltCount: persistent.belts.length,
      completedTechCount: persistent.research.completedTechIds.length,
      structurePoints: integer(persistent.dysonSphere?.structurePoints),
      uploadedWhiteMatrix: integer(persistent.totalProduced?.universe_matrix),
      stateChecksum: serialized.stateChecksum,
      computedStateChecksum: serialized.stateChecksum,
      integrity: "valid" as const,
    };
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
