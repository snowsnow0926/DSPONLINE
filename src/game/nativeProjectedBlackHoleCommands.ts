import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const TEXT_ENCODER = new TextEncoder();

export interface NativeProjectedBlackHolePausedCommandInput {
  readonly baseRevision: number;
  readonly entityId: string;
  readonly paused: boolean;
  readonly confirmActivation: boolean;
}

function validateLogicalId(value: string): void {
  if (typeof value !== "string" || !LOGICAL_ID_PATTERN.test(value) ||
      TEXT_ENCODER.encode(value).byteLength > MAX_LOGICAL_ID_BYTES) {
    throw new TypeError("原生微型黑洞实体 ID 无效");
  }
}

/**
 * Encodes only the player's black-hole intent. Rust re-reads the entity,
 * active planet, built-in registry, lock and current flags at baseRevision,
 * then expands the two persisted leaves transactionally. The semantic marker
 * is also understood by generic WAL replay, so the renderer never predicts a
 * confirmation bit or copies port destruction ledgers into a durable command.
 */
export function createNativeProjectedBlackHolePausedCommand(
  input: NativeProjectedBlackHolePausedCommandInput,
): SimulationCommandPatch {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new TypeError("原生微型黑洞命令 revision 无效");
  }
  validateLogicalId(input.entityId);
  if (typeof input.paused !== "boolean" || typeof input.confirmActivation !== "boolean") {
    throw new TypeError("原生微型黑洞启停意图无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: input.baseRevision,
    topLevelChanges: [],
    changedEntities: [{
      id: input.entityId,
      changes: [{
        path: ["blackHolePaused", "intent"],
        operation: "set",
        value: {
          paused: input.paused,
          confirmActivation: input.confirmActivation,
        },
      }],
    }],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
