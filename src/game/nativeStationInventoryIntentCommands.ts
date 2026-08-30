import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const TEXT_ENCODER = new TextEncoder();
const MAX_PLAYER_ENTITY_ID_BYTES = 160;

function validEntityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_PLAYER_ENTITY_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function emptyCommand(baseRevision: number): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("原生物流站命令版本无效");
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

export type NativeStationFleetKind = "drone" | "vessel";

/**
 * Emits only the requested fleet target. Rust re-reads capacity, active planet,
 * busy routes and portableFleet, then expands all derived leaves durably.
 */
export function createNativeStationFleetTargetIntentCommand(
  baseRevision: number,
  entityId: string,
  kind: NativeStationFleetKind,
  targetCount: number,
): SimulationCommandPatch {
  if (!validEntityId(entityId) || (kind !== "drone" && kind !== "vessel") ||
      !Number.isSafeInteger(targetCount) || targetCount < 0) {
    throw new TypeError("原生物流站舰队语义意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.changedEntities = [{
    id: entityId,
    changes: [{
      path: ["stationFleetTarget", "intent"],
      operation: "set",
      value: { kind, targetCount },
    }],
  }];
  return command;
}

/**
 * Emits only a signed inventory delta. Rust resolves the authoritative station
 * and owning active-planet tray, including capacity and partial stock loading.
 */
export function createNativeStationWarperInventoryIntentCommand(
  baseRevision: number,
  entityId: string,
  delta: number,
): SimulationCommandPatch {
  if (!validEntityId(entityId) || !Number.isSafeInteger(delta) || delta === 0) {
    throw new TypeError("原生物流站翘曲器语义意图无效");
  }
  const command = emptyCommand(baseRevision);
  command.changedEntities = [{
    id: entityId,
    changes: [{
      path: ["stationWarperInventory", "intent"],
      operation: "set",
      value: { delta },
    }],
  }];
  return command;
}
