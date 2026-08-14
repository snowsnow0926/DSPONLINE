import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import type { MulticoreSimulationOptions } from "./multicoreSimulation";
import type { SimulationCommandPatch, SimulationStateTransfer } from "./simulationRuntimeProtocol";
import type { SaveMode } from "./types";

export const SIMULATION_RUNTIME_RECOVERY_SCHEMA_VERSION = 1 as const;
export const SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS = 8;
export const SIMULATION_RUNTIME_RECOVERY_MAX_SIMULATION_SECONDS = 8;
export const SIMULATION_RUNTIME_RECOVERY_MAX_COMMANDS = 4;

export interface SimulationRuntimeRecoveryBaseIdentity {
  mode: SaveMode;
  savedAt: number;
  checksum: string;
  revision: number;
}

/**
 * Exact Worker state that has been durably installed. The old generation must
 * remain readable until the storage layer has verified this transfer and the
 * accompanying empty journal in one committed transaction.
 */
export interface SimulationRuntimeRecoveryCheckpoint {
  schemaVersion: typeof SIMULATION_RUNTIME_RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  generation: number;
  lastSequence: number;
  stateRevision: number;
  registryFingerprint: string;
  registry: ContentPackRuntimeSnapshot;
  committedAtMs: number;
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity;
  transfer: SimulationStateTransfer;
  transferSha256: string;
}

/** One acknowledged Worker request, persisted before its UI response. */
export interface SimulationRuntimeRecoveryOperation {
  schemaVersion: typeof SIMULATION_RUNTIME_RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  generation: number;
  sequence: number;
  baseStateRevision: number;
  nextStateRevision: number;
  command: SimulationCommandPatch | null;
  simulationSeconds: number;
  wallSeconds: number;
  multicore: MulticoreSimulationOptions | undefined;
  approximate: boolean;
  registry: ContentPackRuntimeSnapshot;
  committedAtMs: number;
}

export interface SimulationRuntimeRecoveryRecord {
  checkpoint: SimulationRuntimeRecoveryCheckpoint;
  operations: SimulationRuntimeRecoveryOperation[];
}

export interface SimulationRuntimeRecoveryJournalStats {
  operationCount: number;
  commandCount: number;
  simulationSeconds: number;
  wallSeconds: number;
  lastSequence: number;
  lastStateRevision: number;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function getSimulationRuntimeRecoveryJournalStats(
  checkpoint: Pick<SimulationRuntimeRecoveryCheckpoint, "lastSequence" | "stateRevision">,
  operations: readonly SimulationRuntimeRecoveryOperation[],
): SimulationRuntimeRecoveryJournalStats {
  return operations.reduce<SimulationRuntimeRecoveryJournalStats>((stats, operation) => ({
    operationCount: stats.operationCount + 1,
    commandCount: stats.commandCount + (operation.command ? 1 : 0),
    simulationSeconds: stats.simulationSeconds + operation.simulationSeconds,
    wallSeconds: stats.wallSeconds + operation.wallSeconds,
    lastSequence: operation.sequence,
    lastStateRevision: operation.nextStateRevision,
  }), {
    operationCount: 0,
    commandCount: 0,
    simulationSeconds: 0,
    wallSeconds: 0,
    lastSequence: checkpoint.lastSequence,
    lastStateRevision: checkpoint.stateRevision,
  });
}

/**
 * Keep replay work bounded without putting a full state on ordinary Worker
 * responses. A command-heavy editing burst rolls sooner than passive play.
 */
export function shouldRollSimulationRuntimeRecoveryCheckpoint(
  checkpoint: Pick<SimulationRuntimeRecoveryCheckpoint, "lastSequence" | "stateRevision">,
  operations: readonly SimulationRuntimeRecoveryOperation[],
): boolean {
  const stats = getSimulationRuntimeRecoveryJournalStats(checkpoint, operations);
  return stats.operationCount >= SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS ||
    stats.commandCount >= SIMULATION_RUNTIME_RECOVERY_MAX_COMMANDS ||
    stats.simulationSeconds >= SIMULATION_RUNTIME_RECOVERY_MAX_SIMULATION_SECONDS;
}

export function validateSimulationRuntimeRecoveryRecord(
  value: SimulationRuntimeRecoveryRecord,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
): string | null {
  const { checkpoint, operations } = value;
  if (checkpoint.schemaVersion !== SIMULATION_RUNTIME_RECOVERY_SCHEMA_VERSION) return "unsupported-schema";
  if (!checkpoint.sessionId || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1) return "invalid-checkpoint-identity";
  if (!Number.isSafeInteger(checkpoint.lastSequence) || checkpoint.lastSequence < 0 ||
    !Number.isSafeInteger(checkpoint.stateRevision) || checkpoint.stateRevision < 0) return "invalid-checkpoint-revision";
  if (!finiteNonNegative(checkpoint.committedAtMs) || !checkpoint.registryFingerprint || !checkpoint.transferSha256) return "invalid-checkpoint-metadata";
  if (checkpoint.transfer.byteLength !== checkpoint.transfer.buffer.byteLength || checkpoint.transfer.byteLength <= 0) return "invalid-checkpoint-transfer";
  if (expectedBase && (checkpoint.baseIdentity.mode !== expectedBase.mode ||
    checkpoint.baseIdentity.savedAt !== expectedBase.savedAt ||
    checkpoint.baseIdentity.checksum !== expectedBase.checksum ||
    checkpoint.baseIdentity.revision !== expectedBase.revision)) return "base-identity-mismatch";

  let sequence = checkpoint.lastSequence;
  let revision = checkpoint.stateRevision;
  for (const operation of operations) {
    if (operation.schemaVersion !== SIMULATION_RUNTIME_RECOVERY_SCHEMA_VERSION ||
      operation.sessionId !== checkpoint.sessionId || operation.generation !== checkpoint.generation) return "operation-session-mismatch";
    if (operation.sequence !== sequence + 1 || operation.baseStateRevision !== revision ||
      !Number.isSafeInteger(operation.nextStateRevision) || operation.nextStateRevision < operation.baseStateRevision) return "operation-order-mismatch";
    if (operation.command && operation.command.baseRevision !== operation.baseStateRevision) return "command-revision-mismatch";
    if (!finiteNonNegative(operation.simulationSeconds) || !finiteNonNegative(operation.wallSeconds) ||
      !finiteNonNegative(operation.committedAtMs) || !operation.registry?.fingerprint) return "invalid-operation";
    sequence = operation.sequence;
    revision = operation.nextStateRevision;
  }
  const stats = getSimulationRuntimeRecoveryJournalStats(checkpoint, operations);
  if (operations.length > SIMULATION_RUNTIME_RECOVERY_MAX_OPERATIONS ||
    stats.commandCount > SIMULATION_RUNTIME_RECOVERY_MAX_COMMANDS ||
    stats.simulationSeconds > SIMULATION_RUNTIME_RECOVERY_MAX_SIMULATION_SECONDS + Number.EPSILON) {
    return "journal-bound-exceeded";
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}

/** SHA-256 proof used by the durable store's exact read-back gate. */
export async function computeSimulationStateTransferSha256(transfer: SimulationStateTransfer): Promise<string> {
  if (transfer.byteLength !== transfer.buffer.byteLength) throw new Error("模拟恢复检查点长度无效");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持恢复检查点 SHA-256 校验");
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", transfer.buffer)));
}
