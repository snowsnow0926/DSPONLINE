import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import {
  QUANTUM_ITEM_CAPACITY_MAX,
  QUANTUM_ITEM_CAPACITY_MIN,
} from "./quantumLogisticsNetwork";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const QUANTUM_ITEM_CAPACITY_MIN_VALUE = BigInt(QUANTUM_ITEM_CAPACITY_MIN);
const QUANTUM_ITEM_CAPACITY_MAX_VALUE = BigInt(QUANTUM_ITEM_CAPACITY_MAX);

export interface NativeProjectedQuantumItemCapacityCommandInput {
  /** Exact revision carried by the verified stellar-quantum-v1 frame. */
  readonly baseRevision: number;
  readonly itemId: string;
  /** Canonical current value from that same verified frame. */
  readonly currentCapacity: string;
  readonly targetCapacity: string;
}

function validateBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生量子容量命令 revision 无效");
  }
}

function validateItemId(itemId: string): void {
  if (
    typeof itemId !== "string" ||
    !LOGICAL_ID_PATTERN.test(itemId) ||
    new TextEncoder().encode(itemId).byteLength > MAX_LOGICAL_ID_BYTES
  ) {
    throw new TypeError("原生量子容量命令物品 ID 无效");
  }
}

function validateCapacity(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    value.length > QUANTUM_ITEM_CAPACITY_MAX.length
  ) {
    throw new TypeError(`${label}不是规范十进制整数`);
  }
  const amount = BigInt(value);
  if (amount < QUANTUM_ITEM_CAPACITY_MIN_VALUE || amount > QUANTUM_ITEM_CAPACITY_MAX_VALUE) {
    throw new RangeError(`${label}超出允许范围`);
  }
  return value;
}

/**
 * Builds one capacity leaf from a verified quantum projection row. This does
 * not read GameState or predict the result; Rust rechecks the exact revision,
 * known catalog item, current leaf and target range before durable staging.
 */
export function createNativeProjectedQuantumItemCapacityCommand(
  input: NativeProjectedQuantumItemCapacityCommandInput,
): SimulationCommandPatch | null {
  validateBaseRevision(input.baseRevision);
  validateItemId(input.itemId);
  const currentCapacity = validateCapacity(input.currentCapacity, "原生投影当前量子容量");
  const targetCapacity = validateCapacity(input.targetCapacity, "原生投影目标量子容量");
  if (currentCapacity === targetCapacity) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: input.baseRevision,
    topLevelChanges: [{
      path: ["quantumLogisticsNetwork", "itemCapacities", input.itemId],
      operation: "set",
      value: targetCapacity,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
