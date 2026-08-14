/// <reference lib="webworker" />

import { computeSimulationRuntimeDurableIntentSha256 } from "./simulationRuntimeDurableRecovery";
import {
  clearSimulationRuntimeRecovery,
  commitSimulationRuntimeRecoveryCheckpoint,
  finalizeSimulationRuntimeRecoveryIntent,
  initializeSimulationRuntimeRecovery,
  prepareSimulationRuntimeRecoveryIntent,
  readSimulationRuntimeRecovery,
  rebaseSimulationRuntimeRecoveryToPrimary,
  stageSimulationRuntimeRecoveryIntent,
} from "./simulationRuntimeRecoveryStore";
import type {
  SimulationRuntimeRecoveryPersistenceProgress,
  SimulationRuntimeRecoveryPersistenceRequest,
  SimulationRuntimeRecoveryPersistenceResponse,
} from "./simulationRuntimeRecoveryPersistenceProtocol";

function progress(id: number, value: SimulationRuntimeRecoveryPersistenceProgress): void {
  self.postMessage({ id, type: "progress", progress: value } satisfies SimulationRuntimeRecoveryPersistenceResponse);
}

function sourceCheckpointTransfer(request: SimulationRuntimeRecoveryPersistenceRequest): ArrayBuffer | undefined {
  return (request.type === "initialize" || request.type === "commit-checkpoint") && request.checkpoint.source === "transfer"
    ? request.checkpoint.transfer.buffer
    : undefined;
}

function transferablesForResponse(response: SimulationRuntimeRecoveryPersistenceResponse): Transferable[] {
  if ((response.type === "result" || response.type === "error") &&
    "sourceCheckpointTransfer" in response && response.sourceCheckpointTransfer) {
    return [response.sourceCheckpointTransfer];
  }
  if (response.type === "result" && response.operation === "read" && response.result.ok &&
    response.result.recovery?.checkpoint.source === "transfer") {
    return [response.result.recovery.checkpoint.transfer.buffer];
  }
  return [];
}

function postResponse(response: SimulationRuntimeRecoveryPersistenceResponse): void {
  self.postMessage(response, { transfer: transferablesForResponse(response) });
}

function resultSucceeded(response: SimulationRuntimeRecoveryPersistenceResponse): boolean {
  return response.type === "result" && response.result.ok;
}

function resultFailureReason(response: SimulationRuntimeRecoveryPersistenceResponse): string | undefined {
  return response.type === "result" && !response.result.ok ? response.result.reason : undefined;
}

async function handle(request: SimulationRuntimeRecoveryPersistenceRequest): Promise<void> {
  const { id } = request;
  const checkpointTransfer = sourceCheckpointTransfer(request);
  progress(id, { stage: "queued" });
  try {
    let response: SimulationRuntimeRecoveryPersistenceResponse;
    switch (request.type) {
      case "stage-unsigned": {
        progress(id, {
          stage: "canonicalizing-intent",
          sequence: request.unsigned.sequence,
          generation: request.unsigned.generation,
        });
        const intentSha256 = await computeSimulationRuntimeDurableIntentSha256(request.unsigned);
        const intent = { ...request.unsigned, intentSha256 };
        const prepared = await prepareSimulationRuntimeRecoveryIntent(intent);
        progress(id, {
          stage: "staging-intent",
          sequence: intent.sequence,
          generation: intent.generation,
          totalBytes: prepared.storedByteLength,
        });
        const result = await stageSimulationRuntimeRecoveryIntent(prepared, request.fence);
        response = { id, type: "result", operation: request.type, result, intentSha256 };
        break;
      }
      case "initialize": {
        progress(id, {
          stage: "validating-checkpoint",
          generation: request.checkpoint.generation,
          totalBytes: request.checkpoint.source === "transfer" ? request.checkpoint.transfer.storedByteLength : 0,
        });
        progress(id, { stage: "committing-checkpoint", generation: request.checkpoint.generation });
        const result = await initializeSimulationRuntimeRecovery(request.checkpoint, request.fence);
        response = {
          id,
          type: "result",
          operation: request.type,
          result,
          ...(checkpointTransfer ? { sourceCheckpointTransfer: checkpointTransfer } : {}),
        };
        break;
      }
      case "finalize": {
        progress(id, { stage: "finalizing-intent", sequence: request.sequence, generation: request.generation });
        const result = await finalizeSimulationRuntimeRecoveryIntent(
          request.sessionId,
          request.generation,
          request.sequence,
          request.intentSha256,
          request.resultStateRevision,
          request.fence,
        );
        response = { id, type: "result", operation: request.type, result };
        break;
      }
      case "commit-checkpoint": {
        progress(id, {
          stage: "validating-checkpoint",
          generation: request.checkpoint.generation,
          totalBytes: request.checkpoint.source === "transfer" ? request.checkpoint.transfer.storedByteLength : 0,
        });
        progress(id, { stage: "committing-checkpoint", generation: request.checkpoint.generation });
        const result = await commitSimulationRuntimeRecoveryCheckpoint(
          request.checkpoint,
          request.expectedGeneration,
          request.fence,
          request.absorbedIntent,
        );
        response = {
          id,
          type: "result",
          operation: request.type,
          result,
          ...(checkpointTransfer ? { sourceCheckpointTransfer: checkpointTransfer } : {}),
        };
        break;
      }
      case "rebase-primary": {
        progress(id, { stage: "committing-checkpoint", generation: request.checkpoint.generation, totalBytes: 0 });
        const result = await rebaseSimulationRuntimeRecoveryToPrimary(
          request.checkpoint,
          request.expectedGeneration,
          request.fence,
        );
        response = { id, type: "result", operation: request.type, result };
        break;
      }
      case "read": {
        progress(id, { stage: "reading-recovery" });
        const result = await readSimulationRuntimeRecovery(request.baseIdentity, request.fence);
        response = { id, type: "result", operation: request.type, result };
        break;
      }
      case "clear": {
        progress(id, { stage: "clearing-recovery" });
        const result = await clearSimulationRuntimeRecovery(request.target, request.fence);
        response = { id, type: "result", operation: request.type, result };
        break;
      }
    }
    if (resultSucceeded(response)) progress(id, { stage: "verified" });
    else progress(id, { stage: "failed", failureReason: resultFailureReason(response) });
    postResponse(response);
  } catch (error) {
    progress(id, { stage: "failed", failureReason: "worker-operation" });
    postResponse({
      id,
      type: "error",
      operation: request.type,
      message: error instanceof Error ? error.message : "runtime recovery persistence Worker 失败",
      ...(checkpointTransfer ? { sourceCheckpointTransfer: checkpointTransfer } : {}),
    });
  }
}

let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<SimulationRuntimeRecoveryPersistenceRequest>) => {
  queue = queue.then(() => handle(event.data));
};

export {};
