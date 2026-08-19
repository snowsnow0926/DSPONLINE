import type { PreparedAuthoritativeSavePayload } from "./authoritativeSavePreparation";
import type { AuthoritativeSaveCheckpointOverlay } from "./authoritativeSaveSerializationProtocol";
import {
  validateSimulationStateIdentity,
  type SimulationCommandPatch,
  type SimulationStateIdentity,
} from "./simulationRuntimeProtocol";
import type { GameState } from "./types";

export interface PreparedAuthoritativeSaveCheckpoint {
  prepared: PreparedAuthoritativeSavePayload;
  identity: SimulationStateIdentity;
  saveState: GameState;
  stateRevision: number;
}

export interface SimulationPreparedSaveRequest {
  id: number | null;
  promise: Promise<PreparedAuthoritativeSaveCheckpoint | null>;
  resolve: (checkpoint: PreparedAuthoritativeSaveCheckpoint | null) => void;
  reject: (error: Error) => void;
  kind: "primary" | "snapshot";
  savedAt: number;
  reason?: string;
  expectedState: GameState | null;
  command: SimulationCommandPatch | null;
  checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
}

export function createSimulationPreparedSaveRequest(
  kind: SimulationPreparedSaveRequest["kind"],
  reason?: string,
  savedAt = Date.now(),
): SimulationPreparedSaveRequest {
  let resolve!: SimulationPreparedSaveRequest["resolve"];
  let reject!: SimulationPreparedSaveRequest["reject"];
  const promise = new Promise<PreparedAuthoritativeSaveCheckpoint | null>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    id: null,
    promise,
    resolve,
    reject,
    kind,
    savedAt,
    ...(reason ? { reason } : {}),
    expectedState: null,
    command: null,
  };
}

/** Validate the bounded response identity before the large payload leaves the
 * simulation lifecycle. No envelope decode or gameplay-state comparison is
 * performed on the UI thread. */
export function validatePreparedSaveResponse(
  request: SimulationPreparedSaveRequest,
  preparedSave: PreparedAuthoritativeSavePayload & { identity: SimulationStateIdentity },
  commandApplied: boolean,
): SimulationStateIdentity {
  const identity = validateSimulationStateIdentity(preparedSave.identity);
  const expected = request.expectedState;
  if (!expected || identity.mode !== expected.mode || identity.version !== expected.version ||
    identity.activePlanetId !== expected.activePlanetId || identity.entityCount !== expected.entities.length ||
    identity.beltCount !== expected.belts.length || identity.elapsedSeconds !== expected.elapsedSeconds ||
    identity.paused !== expected.paused || Boolean(request.command) !== commandApplied ||
    preparedSave.summary.kind !== request.kind || preparedSave.summary.savedAt !== request.savedAt ||
    preparedSave.summary.reason !== (request.reason ?? null)) {
    throw new Error("prepared save 与已确认 UI authority 身份不一致");
  }
  return identity;
}
