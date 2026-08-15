import type { ContentPackRegistry } from "./contentPacks";
import type { GameState, SaveMode } from "./types";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
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
}

export type AuthoritativeSaveSerializationRequest = AuthoritativeSaveSerializationRequestCommon & (
  | { state: GameState; stateTransfer?: never }
  | { state?: never; stateTransfer: SimulationStateTransfer }
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
  bytes?: ArrayBuffer;
  sourceStateTransfer?: ArrayBuffer;
  payloadChecksum?: string;
  payloadSha256?: string;
  byteLength?: number;
  durationMs?: number;
  summary?: AuthoritativeSaveSerializationSummary;
  catalogSeed?: AuthoritativeSaveCatalogSeed;
  proof?: AuthoritativeSavePayloadProof;
  error?: string;
}
