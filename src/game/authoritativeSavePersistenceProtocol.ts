import type { GameSettings, SaveMode } from "./types";
import type { LocalSaveCatalogKind } from "./localSaveCatalog";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";

export interface AuthoritativeSaveCatalogSeed {
  mode: SaveMode;
  kind: LocalSaveCatalogKind;
  slot: "main" | 1 | 2 | 3 | null;
  savedAt: number;
  stateVersion: number;
  entityCount: number;
  beltCount: number;
  elapsedSeconds: number;
  completedTechCount: number;
  activePlanetId: string;
  structurePoints: number;
  stateChecksum: string;
  modeExplicit: true;
  reason: string | null;
  settings: Partial<GameSettings> | null;
}

export interface AuthoritativeSavePayloadProof {
  integrity: "valid";
  /** Integrity of the exact uncompressed UTF-8 envelope. */
  payloadChecksum: string;
  payloadSha256: string;
  byteLength: number;
  stateChecksum: string;
  /** Bulk transport is gzip when that reduces the cross-Worker payload. */
  transportEncoding: "raw" | "gzip";
  storedByteLength: number;
  storedSha256: string;
  /** SHA-256 binding the exact payload proof to the canonical catalog seed. */
  bindingSha256: string;
}

export interface AuthoritativeSaveWriterFence {
  ownerId: string;
  fencingToken: number;
}

export type AuthoritativeSavePersistenceFailureReason =
  | "storage-unavailable"
  | "lease-lost"
  | "cas-mismatch"
  | "quota"
  | "transaction-aborted"
  | "readback-failed"
  | "invalid"
  | "backup-unavailable";

export interface AuthoritativeSavePersistenceProof {
  key: string;
  revision: number;
  savedAt: number;
  byteLength: number;
  payloadChecksum: string;
  payloadSha256: string;
  stateChecksum: string;
  transportEncoding: "raw" | "gzip";
  storedByteLength: number;
  backupKey: string | null;
  backupRevision: number | null;
  backupSaved: boolean;
  workerDecodeMs: number;
  idbWriteMs: number;
  backupVerifyMs: number;
  totalBytesWritten: number;
}

export type AuthoritativeSavePersistenceResult =
  | { ok: true; proof: AuthoritativeSavePersistenceProof }
  | {
      ok: false;
      reason: AuthoritativeSavePersistenceFailureReason;
      message: string;
      retryable: boolean;
      degraded: boolean;
      proof?: AuthoritativeSavePersistenceProof;
    };

export type AuthoritativeSavePersistenceProgressStage =
  | "queued"
  | "validating-proof"
  | "decoding-payload"
  | "writing-idb"
  | "readback"
  | "verified"
  | "failed";

export interface AuthoritativeSavePersistenceProgress {
  stage: AuthoritativeSavePersistenceProgressStage;
  key?: string;
  bytes?: number;
  revision?: number;
  reason?: string;
}

export type AuthoritativeSavePersistenceRequest<Payload extends WorkerBinaryPayload = ArrayBuffer> = {
  id: number;
  type: "commit";
  key: string;
  payload: Payload;
  proof: AuthoritativeSavePayloadProof;
  seed: AuthoritativeSaveCatalogSeed;
  expectedRevision: number;
  fence: AuthoritativeSaveWriterFence;
  preserveBackup?: boolean;
};

export type AuthoritativeSavePersistenceResponse =
  | {
      id: number;
      type: "result";
      result: AuthoritativeSavePersistenceResult;
      sourcePayloadTransfer?: ArrayBuffer;
    }
  | {
      id: number;
      type: "progress";
      progress: AuthoritativeSavePersistenceProgress;
    }
  | {
      id: number;
      type: "error";
      message: string;
      sourcePayloadTransfer?: ArrayBuffer;
    };
