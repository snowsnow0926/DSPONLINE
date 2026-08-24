import type { ContentPackRegistry } from "./contentPacks";
import type { CanvasViewport, GameState, PlanetId, SaveMode } from "./types";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
import type { SaveTransferVerification } from "./saveTransfer";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePayloadProof,
} from "./authoritativeSavePersistenceProtocol";

/** Small, non-payload identity supplied by the caller holding the transfer.
 * The save Worker compares these fields after deserializing the transfer so a
 * stale checkpoint cannot be written under a newer requested GameState. */
export interface AuthoritativeSaveExpectedStateIdentity {
  mode: SaveMode;
  version: number;
  activePlanetId: string;
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
}

/**
 * Small state changes that can arrive after the simulation Worker created its
 * exact checkpoint. They are applied by the save Worker after it decodes the
 * transferred checkpoint, so saving an active large factory does not require
 * the UI thread to serialize that checkpoint again.
 */
export interface AuthoritativeSaveCheckpointOverlay {
  planetViewports?: Array<{ planetId: PlanetId; viewport: CanvasViewport }>;
  timeWarp?: {
    pendingSimulationSeconds: number;
    pendingWallSeconds: number;
  };
}

/** A checksum-verified full save envelope produced by another trusted Worker.
 * The save Worker revalidates and parses it before deriving the persistent
 * projection; callers transfer exclusive ownership of `buffer`. */
export interface AuthoritativeSaveEnvelopeTransfer extends SaveTransferVerification {
  buffer: WorkerBinaryPayload;
}

interface AuthoritativeSaveSerializationRequestCommon {
  id: number;
  formatVersion: number;
  savedAt: number;
  kind: "primary" | "slot" | "snapshot";
  slot: "main" | 1 | 2 | 3;
  reason?: string;
  contentPackRegistry: ContentPackRegistry;
  includePayloadSha256?: boolean;
  includeAuthoritativeProof?: boolean;
  expectedStateIdentity?: AuthoritativeSaveExpectedStateIdentity;
  checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
}

export type AuthoritativeSaveSerializationRequest = AuthoritativeSaveSerializationRequestCommon & (
  | { state: GameState; stateTransfer?: never; envelopeTransfer?: never }
  | { state?: never; stateTransfer: SimulationStateTransfer; envelopeTransfer?: never }
  | { state?: never; stateTransfer?: never; envelopeTransfer: AuthoritativeSaveEnvelopeTransfer }
);

export interface AuthoritativeSaveSerializationSummary {
  stateVersion: number;
  savedAt: number;
  mode: "normal" | "speedrun";
  kind: "primary" | "slot" | "snapshot";
  slot: "main" | 1 | 2 | 3;
  reason: string | null;
  elapsedSeconds: number;
  activePlanetId: string;
  entityCount: number;
  beltCount: number;
  completedTechCount: number;
  structurePoints: number;
  uploadedWhiteMatrix: number;
  stateChecksum: string;
  computedStateChecksum: string;
  integrity: "valid";
}

export interface AuthoritativeSaveSerializationResponse {
  id: number;
  bytes?: WorkerBinaryPayload;
  sourceStateTransfer?: WorkerBinaryPayload;
  sourceEnvelopeTransfer?: WorkerBinaryPayload;
  payloadChecksum?: string;
  payloadSha256?: string;
  byteLength?: number;
  durationMs?: number;
  compressionDurationMs?: number;
  summary?: AuthoritativeSaveSerializationSummary;
  catalogSeed?: AuthoritativeSaveCatalogSeed;
  proof?: AuthoritativeSavePayloadProof;
  error?: string;
}
