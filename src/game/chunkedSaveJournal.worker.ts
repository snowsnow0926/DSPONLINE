/// <reference lib="webworker" />

import type { ContentPackRegistry } from "./contentPacks";
import { buildChunkedSaveJournalCommit, type ChunkedSaveJournalCommit, type ChunkedSaveJournalContext, type PersistChunkedSaveOptions } from "./chunkedSaveJournal";
import type { AuthoritativeSaveCheckpointOverlay } from "./authoritativeSaveSerializationProtocol";
import { projectPersistentSaveStateInPlaceOwned } from "./saveProjection";
import { applyAuthoritativeSaveCheckpointOverlay } from "./saveCheckpointOverlay";
import { deserializeSimulationStateTransfer, type SimulationStateTransfer } from "./simulationRuntimeProtocol";

export interface ChunkedSaveJournalWorkerRequest {
  id: number;
  stateTransfer: SimulationStateTransfer;
  checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
  contentPackRegistry: ContentPackRegistry;
  options: PersistChunkedSaveOptions;
  context: ChunkedSaveJournalContext;
}

export interface ChunkedSaveJournalWorkerResponse {
  id: number;
  commit?: ChunkedSaveJournalCommit;
  error?: string;
  sourceStateTransfer?: SimulationStateTransfer;
}

self.onmessage = async (event: MessageEvent<ChunkedSaveJournalWorkerRequest>) => {
  const request = event.data;
  try {
    const authority = deserializeSimulationStateTransfer(request.stateTransfer);
    const overlaid = applyAuthoritativeSaveCheckpointOverlay(authority, request.checkpointOverlay);
    const projected = projectPersistentSaveStateInPlaceOwned(overlaid, request.contentPackRegistry);
    const commit = buildChunkedSaveJournalCommit(projected, request.options, request.context);
    self.postMessage({ id: request.id, commit } satisfies ChunkedSaveJournalWorkerResponse);
  } catch (error) {
    const response: ChunkedSaveJournalWorkerResponse = {
      id: request.id,
      error: error instanceof Error ? error.message : "分块增量存档 Worker 失败",
      sourceStateTransfer: request.stateTransfer,
    };
    self.postMessage(response, [request.stateTransfer.buffer]);
  }
};

export {};
