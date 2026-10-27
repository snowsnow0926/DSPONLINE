import type { ContentPackRegistry } from "./contentPacks";
import type { SaveTransferVerification } from "./saveTransfer";
import type { SaveStateChunkAck } from "./saveStateChunkTransfer";
import type { AuthoritativeSaveSerializationRequest } from "./authoritativeSaveSerializationProtocol";
import type { GameState } from "./types";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";

export type CanonicalTerminalStateRequest = Extract<AuthoritativeSaveSerializationRequest, { state: GameState }>;
export type CanonicalTerminalOwnerRequest =
  | { type: "canonical-start"; payload: WorkerBinaryPayload | null; verification: SaveTransferVerification;
      registry: ContentPackRegistry }
  | { type: "canonical-ack"; ack: SaveStateChunkAck }
  | { type: "canonical-serialize"; request: Omit<CanonicalTerminalStateRequest, "state"> };
