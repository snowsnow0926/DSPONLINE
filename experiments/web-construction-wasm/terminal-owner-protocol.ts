import type { ContentPackRegistry } from "../../src/game/contentPacks";
import type { SaveTransferVerification } from "../../src/game/saveTransfer";
import type { SaveStateChunkAck } from "../../src/game/saveStateChunkTransfer";
import type { AuthoritativeSaveExpectedStateIdentity } from "../../src/game/authoritativeSaveSerializationProtocol";

export type TerminalOwnerRequest =
  | { type: "owner-start"; payload: ArrayBuffer | Blob | null; verification: SaveTransferVerification;
      registry: ContentPackRegistry; returnOnly: boolean }
  | { type: "owner-ack"; ack: SaveStateChunkAck }
  | { type: "owner-serialize"; savedAt: number; expectedStateIdentity: AuthoritativeSaveExpectedStateIdentity };
