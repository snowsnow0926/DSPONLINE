import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_OPAQUE_ID_BYTES = 512;

export interface NativeProjectedManualMineCommandInput {
  readonly baseRevision: number;
  readonly entityId: string;
}

function validateBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生手动采矿命令 revision 无效");
  }
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateEntityId(entityId: string): void {
  // Entity IDs are opaque protocol values. Match the durable command source's
  // boundary so modded Unicode IDs are neither rewritten nor narrowed here.
  if (typeof entityId !== "string" || entityId.length === 0 || entityId.includes("\0") ||
      !hasWellFormedUnicode(entityId) ||
      new TextEncoder().encode(entityId).byteLength > MAX_OPAQUE_ID_BYTES) {
    throw new TypeError("原生手动采矿命令矿脉 ID 无效");
  }
}

/**
 * Builds the smallest durable manual-mining intent. The renderer deliberately
 * supplies no resource ID, output target, reserve delta, technology level or
 * production counters: Rust re-derives all of them from the exact revision.
 */
export function createNativeProjectedManualMineCommand(
  input: NativeProjectedManualMineCommandInput,
): SimulationCommandPatch {
  validateBaseRevision(input.baseRevision);
  validateEntityId(input.entityId);
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: input.baseRevision,
    topLevelChanges: [],
    changedEntities: [{
      id: input.entityId,
      changes: [{ path: ["manualMine"], operation: "set", value: 1 }],
    }],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
