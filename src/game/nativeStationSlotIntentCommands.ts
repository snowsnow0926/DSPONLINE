import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const TEXT_ENCODER = new TextEncoder();
const MAX_PLAYER_IDENTIFIER_BYTES = 160;
const PLAYER_STATION_SLOT_COUNT = 5;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_PLAYER_IDENTIFIER_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生物流站槽位命令版本无效");
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function validSlotIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
    value < PLAYER_STATION_SLOT_COUNT;
}

export type NativeStationSlotScope = "local" | "remote";
export type NativeStationSlotMode = "supply" | "demand" | "storage";

/**
 * Emits only the requested slot mode. Rust re-reads the authoritative station,
 * routes, fleet/warper reservations and legacy mirrors before writing the WAL.
 */
export function createNativeStationSlotModeIntentCommand(
  baseRevision: number,
  entityId: string,
  slotIndex: number,
  scope: NativeStationSlotScope,
  mode: NativeStationSlotMode,
): SimulationCommandPatch {
  if (!validIdentifier(entityId) || !validSlotIndex(slotIndex) ||
      (scope !== "local" && scope !== "remote") ||
      (mode !== "supply" && mode !== "demand" && mode !== "storage")) {
    throw new TypeError("原生物流站槽位模式语义意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.changedEntities = [{
    id: entityId,
    changes: [{
      path: ["stationSlotMode", "intent"],
      operation: "set",
      value: { slotIndex, scope, mode },
    }],
  }];
  return command;
}

/**
 * Emits only the requested item identity (or null to clear it). Rust derives
 * route cancellation, refunds, topology removal and legacy mirrors atomically.
 */
export function createNativeStationSlotItemIntentCommand(
  baseRevision: number,
  entityId: string,
  slotIndex: number,
  itemId: string | null,
): SimulationCommandPatch {
  if (!validIdentifier(entityId) || !validSlotIndex(slotIndex) ||
      (itemId !== null && !validIdentifier(itemId))) {
    throw new TypeError("原生物流站槽位物品语义意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.changedEntities = [{
    id: entityId,
    changes: [{
      path: ["stationSlotItem", "intent"],
      operation: "set",
      value: { slotIndex, itemId },
    }],
  }];
  return command;
}
