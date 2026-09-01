import type { NativeAuthoritativeFactoryCanvasFrame } from "./nativeFactoryCanvasFrame";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_POSITION_ROWS = 4_096;
const MAX_OPAQUE_ID_BYTES = 512;
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const textEncoder = new TextEncoder();

export interface NativeFactoryPositionTarget {
  readonly id: string;
  readonly position: Readonly<{ x: number; y: number }>;
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

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    hasWellFormedUnicode(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    textEncoder.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES;
}

/**
 * Encodes only the final user-selected coordinates. Entity identity, current
 * position, lock state and planet membership are read from the exact Rust
 * viewport revision here and validated again by the authoritative Core.
 */
export function createNativeFactoryPositionCommand(
  frame: NativeAuthoritativeFactoryCanvasFrame,
  baseRevision: number,
  targets: readonly NativeFactoryPositionTarget[],
): SimulationCommandPatch | null {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      baseRevision >= Number.MAX_SAFE_INTEGER || frame.revision !== baseRevision) {
    throw new TypeError("原生建筑位置命令 revision 无效");
  }
  if (targets.length < 1 || targets.length > MAX_POSITION_ROWS) {
    throw new TypeError("原生建筑位置命令目标数量无效");
  }
  const entityOrder = new Map(frame.entities.map((entity, index) => [entity.id, index] as const));
  const seen = new Set<string>();
  const ordered = [...targets].sort((left, right) =>
    (entityOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (entityOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  const changedEntities: SimulationCommandPatch["changedEntities"] = [];
  for (const target of ordered) {
    if (!validOpaqueId(target.id) || seen.has(target.id) ||
        !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y)) {
      throw new TypeError("原生建筑位置命令目标无效");
    }
    seen.add(target.id);
    const entity = frame.entityById.get(target.id);
    if (!entity || entity.planetId !== frame.planetId || entity.interactionLocked) {
      throw new TypeError("原生建筑位置命令目标不属于当前可编辑投影");
    }
    const changes: SimulationCommandPatch["changedEntities"][number]["changes"] = [];
    if (entity.position.x !== target.position.x) {
      changes.push({
        path: ["position", "x"],
        operation: "set" as const,
        value: target.position.x,
      });
    }
    if (entity.position.y !== target.position.y) {
      changes.push({
        path: ["position", "y"],
        operation: "set" as const,
        value: target.position.y,
      });
    }
    if (changes.length > 0) changedEntities.push({ id: target.id, changes });
  }
  if (changedEntities.length === 0) return null;
  const command: SimulationCommandPatch = {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [],
    changedEntities,
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  if (textEncoder.encode(JSON.stringify(command)).byteLength > MAX_DURABLE_COMMAND_BYTES) {
    throw new TypeError("原生建筑位置命令超过 durable 上限");
  }
  return command;
}
