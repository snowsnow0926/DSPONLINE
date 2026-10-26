import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import type {
  PureIdleMacroMode,
  PureIdleMacroPhase,
  PureIdleMacroSummary,
} from "./pureIdleMacro";
import type { SaveTransferVerification } from "./saveTransfer";
import type { GameState, IdleSettlementState, ItemId, SaveMode } from "./types";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";
import type { PureIdleRecoveryReference } from "./pureIdleRecovery";

export type PureIdleMacroWorkerRequest =
  | {
    id: number;
    type: "initialize";
    state?: GameState;
    recovery?: PureIdleRecoveryReference;
    mode: PureIdleMacroMode;
    registry: ContentPackRuntimeSnapshot;
    deadlineMs?: number;
    forceConservativeReason?: string;
    startedPaused?: boolean;
    baselineIdleSettlement?: IdleSettlementState;
    baselineTotalProduced?: Partial<Record<ItemId, number>>;
  }
  | { id: number; type: "advance"; targetWallSeconds: number; deadlineMs?: number }
  | {
    id: number;
    type: "finalize";
    targetWallSeconds: number;
    deadlineMs?: number;
    terminal?: boolean;
    /** Immutable Blob avoids adopting a multi-MiB ArrayBuffer on the UI loop. */
    binaryTransport?: "array-buffer" | "blob";
  }
  | { id: number; type: "cancel"; targetId?: number };

/**
 * Compact identity calculated from the exact state that was serialized into
 * the final envelope. The client binds both the parsed state and the macro
 * summary to this identity before exposing either one to the UI.
 */
export interface PureIdleMacroFinalizedIdentity {
  stateChecksum: string;
  stateVersion: number;
  mode: SaveMode;
  activePlanetId: string;
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
  algorithmVersion: string;
  settledWallSeconds: number;
  settledSimulationSeconds: number;
  registryFingerprint: string;
}

/**
 * Ownership-bearing final envelope. `payloadBytes` remains the original
 * Worker-produced buffer; verification and identity are small immutable
 * proofs bound to those bytes. A caller may transfer the buffer onward, so the
 * property itself is intentionally mutable to accept returned ownership.
 */
export interface PureIdleMacroFinalEnvelopeTransfer<Payload extends WorkerBinaryPayload = ArrayBuffer> {
  payloadBytes: Payload;
  readonly verification: SaveTransferVerification;
  readonly identity: PureIdleMacroFinalizedIdentity;
}

export type PureIdleMacroWorkerResponse =
  | {
    id: number;
    type: "ready" | "advanced";
    summary: PureIdleMacroSummary;
    durationMs: number;
  }
  | {
    id: number;
    type: "progress";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    phase: PureIdleMacroPhase;
    wallClockMs: number;
    algorithmVersion: string;
    completedSimulationSeconds?: number;
    totalSimulationSeconds?: number;
  }
  | {
    id: number;
    type: "cancelled";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    durationMs: number;
  }
  | {
    id: number;
    type: "finalized";
    summary: PureIdleMacroSummary;
    finalEnvelope: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload>;
    durationMs: number;
  }
  | {
    id: number;
    type: "error";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    message: string;
    recoverable: true;
    durationMs: number;
  };
