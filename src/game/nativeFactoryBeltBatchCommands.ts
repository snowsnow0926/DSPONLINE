import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_REQUESTS = 1_024;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_COMMAND_BYTES = 1_048_576;
const encoder = new TextEncoder();

export interface NativeFactoryBeltBatchRequest {
  sourceId: string;
  targetId: string;
  itemId: string;
  tier: number;
  lanes: number;
}

function wellFormedId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      encoder.encode(value).byteLength > MAX_OPAQUE_ID_BYTES) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/**
 * Encodes only a continuous-line gesture list. Generated row IDs, catalog
 * construction IDs, inventory balances and belt defaults remain Rust-owned.
 */
export function createNativeFactoryBeltBatchCommand(
  baseRevision: number,
  requests: readonly NativeFactoryBeltBatchRequest[],
): SimulationCommandPatch {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("原生批量线路 revision 无效");
  }
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_REQUESTS) {
    throw new TypeError("原生批量线路数量无效");
  }
  const routeKeys = new Set<string>();
  const normalized = requests.map((request) => {
    if (!request || !wellFormedId(request.sourceId) || !wellFormedId(request.targetId) ||
        !wellFormedId(request.itemId) || request.sourceId === request.targetId ||
        !Number.isSafeInteger(request.tier) || request.tier < 1 || request.tier > 32 ||
        !Number.isSafeInteger(request.lanes) || request.lanes < 1 || request.lanes > 4_096) {
      throw new TypeError("原生批量线路请求无效");
    }
    const key = JSON.stringify([request.sourceId, request.targetId, request.itemId]);
    if (routeKeys.has(key)) throw new TypeError("原生批量线路包含重复路径");
    routeKeys.add(key);
    return {
      sourceId: request.sourceId,
      targetId: request.targetId,
      itemId: request.itemId,
      tier: request.tier,
      lanes: request.lanes,
    };
  });
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["factoryBeltBatch", "intent"],
      operation: "set",
      value: { requests: normalized },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  if (encoder.encode(JSON.stringify(command)).byteLength > MAX_COMMAND_BYTES) {
    throw new TypeError("原生批量线路命令超过 durable 上限");
  }
  return command;
}
