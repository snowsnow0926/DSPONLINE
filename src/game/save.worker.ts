/// <reference lib="webworker" />

import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { projectPersistentSaveState } from "./saveProjection";
import type { ContentPackRegistry } from "./contentPacks";
import type { GameState } from "./types";

interface SaveWorkerRequest {
  id: number;
  formatVersion: number;
  savedAt: number;
  kind: "primary" | "slot" | "snapshot";
  slot: "main" | 1 | 2 | 3;
  reason?: string;
  state: unknown;
  contentPackRegistry: ContentPackRegistry;
}

interface SaveWorkerResponse {
  id: number;
  bytes?: ArrayBuffer;
  payloadChecksum?: string;
  byteLength?: number;
  durationMs?: number;
  summary?: {
    stateVersion: number;
    savedAt: number;
    elapsedSeconds: number;
    activePlanetId: string;
    entityCount: number;
    completedTechCount: number;
    structurePoints: number;
    uploadedWhiteMatrix: number;
    stateChecksum: string;
    computedStateChecksum: string;
    integrity: "valid";
  };
  error?: string;
}

self.onmessage = (event: MessageEvent<SaveWorkerRequest>) => {
  const startedAt = performance.now();
  try {
    const request = event.data;
    const state = request.state as Record<string, any>;
    const persistent = projectPersistentSaveState(request.state as GameState, request.contentPackRegistry);
    const serialized = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: request.formatVersion,
      kind: request.kind,
      ...(request.reason ? { reason: request.reason } : {}),
      mode: state.mode === "speedrun" ? "speedrun" : "normal",
      slot: request.slot,
      savedAt: request.savedAt,
    });
    const response = {
      id: request.id,
      bytes: serialized.bytes,
      payloadChecksum: serialized.payloadChecksum,
      byteLength: serialized.byteLength,
      durationMs: Math.max(0, performance.now() - startedAt),
      summary: {
        stateVersion: Number.isFinite(state.version) ? Math.max(0, Math.floor(state.version)) : 0,
        savedAt: request.savedAt,
        elapsedSeconds: Number.isFinite(state.elapsedSeconds) ? Math.max(0, Math.floor(state.elapsedSeconds)) : 0,
        activePlanetId: typeof state.activePlanetId === "string" ? state.activePlanetId : "home",
        entityCount: Array.isArray(state.entities) ? state.entities.length : 0,
        completedTechCount: Array.isArray(state.research?.completedTechIds) ? state.research.completedTechIds.length : 0,
        structurePoints: Number.isFinite(state.dysonSphere?.structurePoints) ? Math.max(0, Math.floor(state.dysonSphere.structurePoints)) : 0,
        uploadedWhiteMatrix: Number.isFinite(state.totalProduced?.universe_matrix) ? Math.max(0, Math.floor(state.totalProduced.universe_matrix)) : 0,
        stateChecksum: serialized.stateChecksum,
        computedStateChecksum: serialized.stateChecksum,
        integrity: "valid",
      },
    } satisfies SaveWorkerResponse;
    self.postMessage(response, [serialized.bytes]);
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : "后台生成存档失败" } satisfies SaveWorkerResponse);
  }
};

export {};
