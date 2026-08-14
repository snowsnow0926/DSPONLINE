import type { SimulationRuntimeRecoveryBaseIdentity } from "./simulationRuntimeRecovery";
import type {
  SimulationRuntimeDurableCheckpoint,
  SimulationRuntimeDurableOperationIntent,
  SimulationRuntimeDurablePrimaryCheckpoint,
} from "./simulationRuntimeDurableRecovery";
import type {
  SimulationRuntimeRecoveryAbsorbedIntent,
  SimulationRuntimeRecoveryClearResult,
  SimulationRuntimeRecoveryClearTarget,
  SimulationRuntimeRecoveryMutationResult,
  SimulationRuntimeRecoveryReadResult,
  SimulationRuntimeRecoveryWriterFence,
} from "./simulationRuntimeRecoveryStore";

export type SimulationRuntimeRecoveryUnsignedIntent = Omit<SimulationRuntimeDurableOperationIntent, "intentSha256">;

export type SimulationRuntimeRecoveryPersistenceStage =
  | "queued"
  | "canonicalizing-intent"
  | "staging-intent"
  | "finalizing-intent"
  | "validating-checkpoint"
  | "committing-checkpoint"
  | "reading-recovery"
  | "clearing-recovery"
  | "verified"
  | "failed";

export interface SimulationRuntimeRecoveryPersistenceProgress {
  stage: SimulationRuntimeRecoveryPersistenceStage;
  sequence?: number;
  generation?: number;
  totalBytes?: number;
  failureReason?: string;
}

export type SimulationRuntimeRecoveryPersistenceRequest =
  | {
      id: number;
      type: "stage-unsigned";
      unsigned: SimulationRuntimeRecoveryUnsignedIntent;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "initialize";
      checkpoint: SimulationRuntimeDurableCheckpoint;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "finalize";
      sessionId: string;
      generation: number;
      sequence: number;
      intentSha256: string;
      resultStateRevision: number;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "commit-checkpoint";
      checkpoint: SimulationRuntimeDurableCheckpoint;
      expectedGeneration: number;
      absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "rebase-primary";
      checkpoint: SimulationRuntimeDurablePrimaryCheckpoint;
      expectedGeneration: number;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "read";
      baseIdentity: SimulationRuntimeRecoveryBaseIdentity;
      fence: SimulationRuntimeRecoveryWriterFence;
    }
  | {
      id: number;
      type: "clear";
      target: SimulationRuntimeRecoveryClearTarget;
      fence: SimulationRuntimeRecoveryWriterFence;
    };

export type SimulationRuntimeRecoveryPersistenceSuccess =
  | {
      id: number;
      type: "result";
      operation: "stage-unsigned";
      result: SimulationRuntimeRecoveryMutationResult;
      intentSha256: string;
    }
  | {
      id: number;
      type: "result";
      operation: "initialize" | "commit-checkpoint";
      result: SimulationRuntimeRecoveryMutationResult;
      /** Ownership is transferred back on both durable success and failure. */
      sourceCheckpointTransfer?: ArrayBuffer;
    }
  | {
      id: number;
      type: "result";
      operation: "finalize" | "rebase-primary";
      result: SimulationRuntimeRecoveryMutationResult;
    }
  | {
      id: number;
      type: "result";
      operation: "read";
      result: SimulationRuntimeRecoveryReadResult;
    }
  | {
      id: number;
      type: "result";
      operation: "clear";
      result: SimulationRuntimeRecoveryClearResult;
    };

export type SimulationRuntimeRecoveryPersistenceResponse =
  | SimulationRuntimeRecoveryPersistenceSuccess
  | {
      id: number;
      type: "progress";
      progress: SimulationRuntimeRecoveryPersistenceProgress;
    }
  | {
      id: number;
      type: "error";
      operation: SimulationRuntimeRecoveryPersistenceRequest["type"];
      message: string;
      /** Present when an input checkpoint buffer is still owned by the Worker. */
      sourceCheckpointTransfer?: ArrayBuffer;
    };
